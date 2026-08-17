//! A from-scratch desktop shell for the DeepSeek Harness (`dsh`) web UI.
//!
//! How it works:
//! 1. Spawn the official `dsh` Node host with `--profile web --port 0`
//!    (port 0 lets the OS pick a free port).
//! 2. Read the host's stdout and wait for the printed `http://127.0.0.1:<port>`
//!    URL (tolerating ANSI escapes / hyperlink wrappers).
//! 3. Navigate the window to that URL; the embedded `dist/index.html` acts as
//!    a loading screen in the meantime.
//! 4. Closing the window hides it to the tray (the host keeps running);
//!    the tray "退出" action or a host failure exits the app and force-kills
//!    the host process tree.
//!
//! All code in this crate is original. The only pattern taken from elsewhere
//! is the publicly documented Tauri "Node.js sidecar" idea (see
//! https://v2.tauri.app/learn/sidecar-nodejs/): spawn a local process, parse
//! its output, point the webview at it.

use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Listener, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_updater::UpdaterExt;

const READY_EVENT: &str = "dsh-host-ready";
const ERROR_EVENT: &str = "dsh-host-error";
const WINDOW_LABEL: &str = "main";

/// State shared between the setup threads and the event loop.
pub struct HostState {
    child: Mutex<Option<HostChild>>,
    ready: AtomicBool,
    shutting_down: AtomicBool,
    /// Handle of our own named mutex (Windows): keeps the belt-and-braces
    /// single-instance claim alive for the whole process lifetime. Windows
    /// releases the underlying object automatically on process death.
    instance_mutex: Mutex<Option<isize>>,
    /// Exit code the app SHOULD end with. Tauri 2.11.5 discards non-zero
    /// codes on Windows (tauri-runtime-wry sets `ControlFlow::Exit`, which
    /// always maps to 0), so the RunEvent::Exit handler re-applies it via
    /// `std::process::exit` after the graceful teardown.
    desired_exit_code: AtomicI32,
    /// Guards against concurrent update checks/installs.
    updating: AtomicBool,
    /// The startup auto-check runs exactly once per process.
    auto_update_checked: AtomicBool,
}

/// Outcome of our own single-instance claim (the plugin remains the primary
/// guard; this layer only catches the case where the plugin's hidden event
/// window was destroyed, which disables its second-instance detection).
enum InstanceClaim {
    /// This process owns the claim; the raw handle keeps the mutex alive.
    Primary(isize),
    /// Another instance is already running: exit without spawning a host.
    Secondary,
}

/// Take a named mutex keyed on the app identifier. The mutex object lives
/// until the process dies, so no explicit release is needed on exit.
#[cfg(windows)]
fn claim_single_instance(identifier: &str) -> InstanceClaim {
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_ALREADY_EXISTS},
        System::Threading::CreateMutexW,
    };
    let mut name: Vec<u16> = format!("{identifier}-app-single-instance")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_mut_ptr()) };
    if handle.is_null() {
        // Could not create the mutex at all: give the benefit of the doubt
        // and continue; the plugin still guards the normal path.
        return InstanceClaim::Primary(0);
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        InstanceClaim::Secondary
    } else {
        InstanceClaim::Primary(handle as isize)
    }
}

#[cfg(not(windows))]
fn claim_single_instance(_identifier: &str) -> InstanceClaim {
    InstanceClaim::Primary(0)
}

/// Windows Job Object attached to the host process: if the shell is ever
/// force-killed (Task Manager, installer, crash), the OS closes our job
/// handle and JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE terminates the entire
/// node.exe process tree — no orphans, even when no cleanup code runs.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    /// Owns one job object HANDLE; Drop closes it. Closing the last handle
    /// to a KILL_ON_JOB_CLOSE job terminates every process assigned to it.
    pub struct Job(HANDLE);

    // A Job has a single owner and is only closed in Drop; the HANDLE inside
    // is inert raw state otherwise.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// Create the job, arm KILL_ON_JOB_CLOSE and assign the host process.
        /// Returns a descriptive error for each failing step.
        pub fn create_and_assign(child: &std::process::Child) -> Result<Self, String> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err("CreateJobObjectW returned null".to_string());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set_ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if set_ok == 0 {
                unsafe { CloseHandle(handle) };
                return Err("SetInformationJobObject failed".to_string());
            }
            let assign_ok =
                unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) };
            if assign_ok == 0 {
                unsafe { CloseHandle(handle) };
                return Err("AssignProcessToJobObject failed".to_string());
            }
            Ok(Job(handle))
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// Native modal dialogs via the Windows MessageBox — no extra plugin.
#[cfg(windows)]
mod dialog {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK,
        MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Yes/No question; true = user chose Yes.
    pub fn confirm(title: &str, text: &str) -> bool {
        let t = wide(title);
        let x = wide(text);
        let ret = unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                x.as_ptr(),
                t.as_ptr(),
                MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST,
            )
        };
        ret == IDYES
    }

    pub fn info(title: &str, text: &str) {
        let t = wide(title);
        let x = wide(text);
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                x.as_ptr(),
                t.as_ptr(),
                MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST,
            );
        };
    }

    pub fn error(title: &str, text: &str) {
        let t = wide(title);
        let x = wide(text);
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                x.as_ptr(),
                t.as_ptr(),
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST,
            );
        };
    }
}

#[cfg(not(windows))]
mod dialog {
    pub fn confirm(_title: &str, _text: &str) -> bool {
        false
    }
    pub fn info(_title: &str, _text: &str) {}
    pub fn error(_title: &str, _text: &str) {}
}

/// Update flow: check → confirm → download (host keeps running) → stop host
/// → install (the updater plugin launches the NSIS installer and exits this
/// process; the installer relaunches the app). Runs in a worker thread; a
/// guard in `check_for_updates` prevents concurrent flows.
fn run_update_flow<R: tauri::Runtime>(app: &AppHandle<R>, user_initiated: bool) {
    let fail = |e: String| {
        log(&format!("[dsh-desktop] update check failed: {e}"));
        if user_initiated {
            dialog::error("检查更新失败", &format!("{e}\n\n请检查网络连接后重试。"));
        }
    };

    // Explicit 30s timeout so a hung check cannot wedge the flow guard.
    let updater = match app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(u) => u,
        Err(e) => return fail(e.to_string()),
    };

    let update = match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(u)) => u,
        Ok(None) => {
            if user_initiated {
                dialog::info("检查更新", "当前已是最新版本。");
            }
            return;
        }
        Err(e) => return fail(e.to_string()),
    };

    let current = app.package_info().version.to_string();
    let version = update.version.clone();
    let body = update.body.clone().unwrap_or_default();
    let text = format!(
        "发现新版本：{version}\n当前版本：{current}\n\n更新说明：\n{body}\n\n\
         安装更新将重启应用，并中断当前运行中的本地任务。\n\n是否现在下载并安装？"
    );
    if !dialog::confirm("DSH Desktop 更新", &text) {
        log(&format!("[dsh-desktop] update {version} declined by user"));
        return;
    }

    // Download while the Harness session keeps running; the signature is
    // verified inside download(), so a bad signature fails here harmlessly.
    let bytes = match tauri::async_runtime::block_on(update.download(|_chunk, _total| {}, || {})) {
        Ok(b) => b,
        Err(e) => {
            dialog::error("更新失败", &format!("下载或签名验证失败：{e}"));
            log(&format!("[dsh-desktop] update download failed: {e}"));
            return;
        }
    };

    // Download complete: stop the host tree before the installer runs.
    let state = app.state::<HostState>();
    state.shutting_down.store(true, Ordering::SeqCst);
    if let Some(mut host) = state.child.lock().unwrap().take() {
        kill_tree(&mut host.child);
    }

    match update.install(bytes) {
        Ok(()) => {
            // On Windows install() exits the process itself; on other
            // platforms restart so the updated binary runs.
            app.restart();
        }
        Err(e) => {
            // Host is already stopped: do not leave the user on a dead
            // WebView. Show the error and exit the old version.
            dialog::error(
                "更新失败",
                &format!("安装程序启动失败：{e}\n\n应用将退出，请重新打开。"),
            );
            log(&format!("[dsh-desktop] updater install failed: {e}"));
            request_exit(app, 1);
        }
    }
}

/// Start an update check on a worker thread; concurrent flows are refused.
/// `user_initiated` failures surface as dialogs, background failures only log.
fn check_for_updates<R: tauri::Runtime>(app: AppHandle<R>, user_initiated: bool) {
    let state = app.state::<HostState>();
    if state
        .updating
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log("[dsh-desktop] update flow already in progress; ignoring new request");
        return;
    }
    thread::spawn(move || {
        run_update_flow(&app, user_initiated);
        app.state::<HostState>()
            .updating
            .store(false, Ordering::SeqCst);
    });
}

/// Owns the host `Child` and guarantees the process tree dies on *every*
/// path: normal exits run kill_tree explicitly, and the Job Object (Windows)
/// kills the tree even when the shell itself is force-terminated.
struct HostChild {
    child: Child,
    #[cfg(windows)]
    // Never read directly: held only so its Drop closes the job handle.
    #[allow(dead_code)]
    job: job::Job,
}

impl Drop for HostChild {
    fn drop(&mut self) {
        kill_tree(&mut self.child);
        // `job` drops after `child`: closing the job handle then terminates
        // any remaining processes in the tree.
    }
}

/// Which command line launches the dsh web host.
enum HostCommand {
    /// `node <cli> --profile web --port 0`
    Node { node: PathBuf, cli: PathBuf },
    /// `dsh --profile web --port 0` (resolved from PATH)
    DshOnPath,
}

/// Append a line to stderr when one exists, and best-effort to a log file
/// next to the executable. Never panics: release builds have no console and
/// `print!`/`eprintln!` panic when the handle write fails.
fn log(message: &str) {
    let line = format!("{message}\n");
    let _ = std::io::stderr().write_all(line.as_bytes());
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("dsh-desktop.log"))
            {
                let _ = file.write_all(line.as_bytes());
            }
        }
    }
}

/// Extract a `http://127.0.0.1:<port>`-style URL from a host log line,
/// tolerating ANSI escapes and hyperlink (OSC 8) wrappers.
fn extract_url(line: &str) -> Option<String> {
    const PREFIX: &str = "http://";
    let start = line.find(PREFIX)?;
    let rest = &line[start..];
    let url: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '\x1b' && *c != '"' && *c != '\'')
        .collect();
    let is_local = url.contains("127.0.0.1") || url.contains("localhost");
    if url.len() > PREFIX.len() && is_local {
        Some(url)
    } else {
        None
    }
}

/// Force-kill the host and (on Windows) its whole process tree.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Tauri's `resource_dir` can carry the Windows verbatim `\\?\` prefix,
/// which Node.js argv parsing cannot handle (it mangles `\\?\E:\...` into
/// `E:` and fails with EISDIR). Strip it before spawning.
fn plain_path(path: &std::path::Path) -> PathBuf {
    let text = path.to_string_lossy();
    let stripped = text.strip_prefix(r"\\?\").unwrap_or(&text);
    PathBuf::from(stripped.to_string())
}

/// Focus the main window (show → unminimize → focus); failures are logged,
/// never fatal. Shared by the tray, the single-instance callback and the
/// second-instance wake-up path.
fn show_main_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(WINDOW_LABEL) {
        Some(win) => {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        None => log("[dsh-desktop] show_main_window: main window not found"),
    }
}

/// Mark the app as shutting down (so a closing window cannot hide to the
/// tray mid-exit) and request process exit. Host tree cleanup happens in the
/// existing RunEvent::ExitRequested/Exit handlers; the requested code is
/// re-applied in RunEvent::Exit because Tauri 2.11.5 drops it on Windows.
fn request_exit<R: tauri::Runtime>(app: &AppHandle<R>, code: i32) {
    let state = app.state::<HostState>();
    state.desired_exit_code.store(code, Ordering::SeqCst);
    state.shutting_down.store(true, Ordering::SeqCst);
    app.exit(code);
}

/// Decide which command to run, in priority order:
/// 1. `DSH_NODE` + `DSH_CLI` env vars (development loop against a checkout)
/// 2. bundled `resources/host/node.exe` + `resources/host/cli/lib/bin.js`
///    (phase 2: fully self-contained package)
/// 3. `dsh` on PATH
fn resolve_host_command(app: &App) -> HostCommand {
    let node_env = std::env::var("DSH_NODE").ok().filter(|v| !v.is_empty());
    let cli_env = std::env::var("DSH_CLI").ok().filter(|v| !v.is_empty());
    if let (Some(node), Some(cli)) = (node_env, cli_env) {
        return HostCommand::Node {
            node: node.into(),
            cli: cli.into(),
        };
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        let res_dir = plain_path(&res_dir);
        for node_name in ["node.exe", "node"] {
            let node = res_dir.join("host").join(node_name);
            // Two bundled CLI layouts: the deploy-root layout puts the dsh
            // package under node_modules/, the plain layout has lib/bin.js at
            // the cli root.
            for cli in [
                res_dir.join("host").join("cli").join("lib").join("bin.js"),
                res_dir
                    .join("host")
                    .join("cli")
                    .join("node_modules")
                    .join("@deepseek-ai")
                    .join("dsh")
                    .join("lib")
                    .join("bin.js"),
            ] {
                if node.exists() && cli.exists() {
                    return HostCommand::Node { node, cli };
                }
            }
        }
    }
    HostCommand::DshOnPath
}

/// Spawn the dsh web host and attach the Windows Job Object. If the job
/// cannot be created/configured/assigned, the freshly spawned host is killed
/// immediately and an error is returned — the shell never runs without
/// process-lifecycle protection.
fn spawn_host(app: &App) -> Result<HostChild, String> {
    let extra_args: Vec<String> = std::env::var("DSH_WEB_ARGS")
        .unwrap_or_default()
        .split_whitespace()
        .map(String::from)
        .collect();

    let host_cmd = resolve_host_command(app);
    match &host_cmd {
        HostCommand::Node { node, cli } => {
            log(&format!(
                "[dsh-desktop] spawn: {} {}",
                node.display(),
                cli.display()
            ));
        }
        HostCommand::DshOnPath => {
            log("[dsh-desktop] spawn: dsh (PATH)");
        }
    }

    let mut cmd = match host_cmd {
        HostCommand::Node { node, cli } => {
            let mut c = Command::new(node);
            c.arg(cli);
            c
        }
        HostCommand::DshOnPath => Command::new("dsh"),
    };

    cmd.args(["--profile", "web", "--port", "0"])
        .args(&extra_args)
        .stdout(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if cfg!(debug_assertions) {
            // Dev: keep stderr on our console so dsh errors are visible.
            cmd.stderr(Stdio::inherit());
        } else {
            // Packaged builds have no console: hide the child's own window
            // but pipe stderr so watch_stdout can log host failures.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW).stderr(Stdio::piped());
        }
    }
    #[cfg(not(windows))]
    {
        cmd.stderr(Stdio::inherit());
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "failed to start dsh host: {e}. \
             Set DSH_NODE and DSH_CLI (see README) or put `dsh` on PATH."
        )
    })?;

    #[cfg(windows)]
    let job = match job::Job::create_and_assign(&child) {
        Ok(job) => job,
        Err(e) => {
            kill_tree(&mut child);
            return Err(format!("job object setup failed: {e}"));
        }
    };

    Ok(HostChild {
        child,
        #[cfg(windows)]
        job,
    })
}

/// Read the host's stdout line by line; the first localhost URL marks the
/// host as ready and is emitted to the UI thread. On EOF, emit an error
/// unless the app is already shutting down. The host's stderr is logged too.
fn watch_stdout(app: &App, child: &mut Child) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let handle = app.handle().clone();

    if let Some(err) = stderr {
        thread::spawn(move || {
            let mut reader = BufReader::new(err);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => log(&format!("[dsh:err] {}", line.trim_end())),
                }
            }
        });
    }

    let Some(stdout) = stdout else {
        return;
    };
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    log(&format!("[dsh] {}", line.trim_end()));
                    let state = handle.state::<HostState>();
                    if !state.ready.load(Ordering::SeqCst) {
                        if let Some(url) = extract_url(&line) {
                            state.ready.store(true, Ordering::SeqCst);
                            let _ = handle.emit(READY_EVENT, url);
                        }
                    }
                }
                Err(e) => {
                    log(&format!("[dsh-desktop] stdout read error: {e}"));
                    break;
                }
            }
        }
        let state = handle.state::<HostState>();
        if state.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let message = if state.ready.load(Ordering::SeqCst) {
            "dsh host exited unexpectedly".to_string()
        } else {
            "dsh host exited before publishing its web URL \
             (see console output above)"
                .to_string()
        };
        let _ = handle.emit(ERROR_EVENT, message);
    });
}

/// Fail the app if the host never publishes a URL in time.
fn start_watchdog(app: &App) {
    let timeout_secs: u64 = std::env::var("DSH_HOST_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120);
    let handle = app.handle().clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(timeout_secs));
        let state = handle.state::<HostState>();
        if state.ready.load(Ordering::SeqCst) || state.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        if let Some(mut child) = state.child.lock().unwrap().take() {
            kill_tree(&mut child.child);
        }
        let message = format!("timed out after {timeout_secs}s waiting for the dsh web URL");
        let _ = handle.emit(ERROR_EVENT, message);
    });
}

/// Build a minimal tray icon: left click re-shows the window, menu has
/// "显示窗口" and "退出". Purely cosmetic: failures are logged, not fatal.
fn build_tray(app: &App) {
    let Some(icon) = app.default_window_icon().cloned() else {
        return;
    };
    let show = match MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => {
            log(&format!("[dsh-desktop] tray menu item failed: {e}"));
            return;
        }
    };
    let quit = match MenuItem::with_id(app, "quit", "退出", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => {
            log(&format!("[dsh-desktop] tray menu item failed: {e}"));
            return;
        }
    };
    let check_update = match MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)
    {
        Ok(i) => i,
        Err(e) => {
            log(&format!("[dsh-desktop] tray menu item failed: {e}"));
            return;
        }
    };
    let menu = match Menu::with_items(app, &[&show, &check_update, &quit]) {
        Ok(m) => m,
        Err(e) => {
            log(&format!("[dsh-desktop] tray menu failed: {e}"));
            return;
        }
    };
    if let Err(e) = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("DeepSeek Harness Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "check-update" => check_for_updates(app.clone(), true),
            "quit" => request_exit(app, 0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
    {
        log(&format!("[dsh-desktop] tray icon failed: {e}"));
    }
}

/// Entry point invoked from `src/main.rs`.
pub fn run() {
    let app = tauri::Builder::default()
        // Second instance: wake the existing window and let this instance
        // exit (the plugin aborts it before setup runs, so no second host,
        // no second tray). argv/cwd are deliberately not logged to avoid
        // leaking paths or other sensitive command-line content.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .manage(HostState {
            child: Mutex::new(None),
            ready: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            instance_mutex: Mutex::new(None),
            desired_exit_code: AtomicI32::new(0),
            updating: AtomicBool::new(false),
            auto_update_checked: AtomicBool::new(false),
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == WINDOW_LABEL {
                    let shutting = window
                        .state::<HostState>()
                        .shutting_down
                        .load(Ordering::SeqCst);
                    if !shutting {
                        // X = hide to tray; the dsh host keeps running.
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .setup(|app| {
            // Belt-and-braces single-instance claim: normally the plugin
            // already aborted a second instance before this setup runs; this
            // only fires when the plugin's hidden event window is gone.
            match claim_single_instance(&app.config().identifier) {
                InstanceClaim::Primary(handle) => {
                    *app.state::<HostState>().instance_mutex.lock().unwrap() = Some(handle);
                }
                InstanceClaim::Secondary => {
                    log("[dsh-desktop] another instance is running; exiting without spawning a host");
                    request_exit(app.handle(), 0);
                    return Ok(());
                }
            }

            // Listeners first: they must be live before any emit.
            let ready_handle = app.handle().clone();
            app.listen(READY_EVENT, move |event| {
                if let Ok(url) = serde_json::from_str::<String>(event.payload()) {
                    if let Some(win) = ready_handle.get_webview_window(WINDOW_LABEL) {
                        // Tauri 2.x: WebviewWindow::navigate takes a url::Url.
                        match url::Url::parse(&url) {
                            Ok(target) => {
                                let _ = win.navigate(target);
                            }
                            Err(e) => {
                                log(&format!("[dsh-desktop] unparsable host URL {url:?}: {e}"));
                            }
                        }
                    }
                }
                // The UI is up: run the startup update check exactly once;
                // failures are log-only.
                let state = ready_handle.state::<HostState>();
                if !state.auto_update_checked.swap(true, Ordering::SeqCst) {
                    check_for_updates(ready_handle.clone(), false);
                }
            });

            let error_handle = app.handle().clone();
            app.listen(ERROR_EVENT, move |event| {
                let message = serde_json::from_str::<String>(event.payload())
                    .unwrap_or_else(|_| "unknown dsh host error".to_string());
                log(&format!("[dsh-desktop] {message}"));
                request_exit(&error_handle, 1);
            });

            match spawn_host(app) {
                Ok(mut host) => {
                    watch_stdout(app, &mut host.child);
                    *app.state::<HostState>().child.lock().unwrap() = Some(host);
                }
                Err(message) => {
                    log(&format!("[dsh-desktop] {message}"));
                    request_exit(app.handle(), 1);
                    return Ok(());
                }
            }
            start_watchdog(app);
            build_tray(app);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the dsh-desktop shell");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } => {
            let state = app_handle.state::<HostState>();
            state.shutting_down.store(true, Ordering::SeqCst);
            if let Some(mut child) = state.child.lock().unwrap().take() {
                kill_tree(&mut child.child);
            };
        }
        RunEvent::Exit => {
            // Belt-and-braces; normally already handled by ExitRequested.
            if let Some(mut child) = app_handle.state::<HostState>().child.lock().unwrap().take() {
                kill_tree(&mut child.child);
            };
            // Tauri 2.11.5 discards non-zero exit codes on Windows; re-apply
            // the requested code now that the graceful teardown has run.
            let code = app_handle
                .state::<HostState>()
                .desired_exit_code
                .load(Ordering::SeqCst);
            if code != 0 {
                std::process::exit(code);
            }
        }
        _ => {}
    });
}
