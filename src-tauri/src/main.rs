// Windows: hide the console window in release builds (dev keeps it for logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dsh_desktop_lib::run();
}
