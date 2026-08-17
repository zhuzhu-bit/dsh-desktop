// Regenerate (or verify) THIRD_PARTY_NOTICES.md for the released bundle.
//
//   node scripts/gen-third-party-notices.mjs           # write the file
//   node scripts/gen-third-party-notices.mjs --check   # CI: verify freshness
//
// Sources:
//   - Rust crates: cargo-about over src-tauri/Cargo.lock (deterministic)
//   - DeepSeek Harness LICENSE + THIRD_PARTY_NOTICES.md at the pinned commit
//     (raw.githubusercontent.com; DSH_HARNESS_REPO env can point at a local
//     checkout to stay offline)
//   - Node.js LICENSE at the pinned node tag
//   - npm closure license summary: `pnpm licenses list --prod` over
//     resources/host/cli (requires the generated closure)
//
// --check compares the generated document against the committed file. When
// the closure is absent (plain CI runs), the npm summary section is exempted;
// the release workflow runs --check with the closure present and is strict.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shell = process.platform === 'win32'
const check = process.argv.includes('--check')

const HARNESS_COMMIT = process.env.DSH_HARNESS_COMMIT ?? '47f943859bef60e4160492346772ded9b24f765a'
const NODE_VERSION = process.env.DSH_NODE_VERSION ?? 'v24.9.0'
const VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const cliDir = join(root, 'src-tauri', 'resources', 'host', 'cli')
const outPath = join(root, 'THIRD_PARTY_NOTICES.md')

const NPM_SECTION_START = '## 4. Bundled npm production closure'
const NPM_MARKER = '<!-- NPM-SUMMARY -->'

function fetchText(url) {
  if (shell) {
    return execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -Uri '${url}' -UseBasicParsing).Content`,
    ], { encoding: 'utf8' })
  }
  return execFileSync('curl', ['-fsSL', url], { encoding: 'utf8' })
}

function harnessText(rel) {
  const local = process.env.DSH_HARNESS_REPO
  if (local) {
    const p = join(local, rel)
    if (existsSync(p)) return readFileSync(p, 'utf8')
    throw new Error(`${p} missing; set DSH_HARNESS_REPO to a full checkout`)
  }
  return fetchText(`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${HARNESS_COMMIT}/${rel}`)
}

function npmSummary() {
  const nm = join(cliDir, 'node_modules')
  const hasClosure = existsSync(join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  if (!hasClosure) {
    return `${NPM_MARKER} closure not generated in this checkout; the release workflow verifies this section`
  }
  // Direct walk of the hoisted closure tree (no pnpm invocation: the deploy
  // manifest uses alias-style specs that the licenses subcommand cannot
  // resolve, and a plain tree walk is deterministic).
  const rows = []
  const licenseOf = (value) => {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && typeof value.type === 'string') return value.type
    return 'unknown'
  }
  const collect = (dir, scope) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const pkgPath = join(dir, entry.name, 'package.json')
      if (!existsSync(pkgPath)) continue
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.name && pkg.version !== undefined) {
          rows.push([scope ? `${scope}/${entry.name}` : entry.name, pkg.version, licenseOf(pkg.license)])
        }
      } catch {
        continue
      }
    }
  }
  collect(nm, null)
  for (const scopeDir of readdirSync(nm, { withFileTypes: true })) {
    if (scopeDir.isDirectory() && scopeDir.name.startsWith('@')) {
      collect(join(nm, scopeDir.name), scopeDir.name)
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]))
  const lines = [
    '',
    '| package | version | license |',
    '|---|---|---|',
  ]
  for (const [name, version, license] of rows) {
    lines.push(`| ${name} | ${version} | ${license} |`)
  }
  return lines.join('\n')
}

function rustNotices() {
  // cargo-about refuses to write its output through a PowerShell pipe
  // (encoding issues), so render into a temp file and read it back.
  const tmp = join(tmpdir(), `dsh-about-${process.pid}.txt`)
  execFileSync('cargo', [
    'about', 'generate',
    '--manifest-path', join(root, 'src-tauri', 'Cargo.toml'),
    '-o', tmp,
    join(root, 'build-support', 'notices', 'about.hbs'),
  ], { shell, stdio: 'inherit' })
  const text = readFileSync(tmp, 'utf8')
  rmSync(tmp, { force: true })
  return text
}

function render() {
  let template = readFileSync(join(root, 'build-support', 'notices', 'template.md'), 'utf8')
  const subs = {
    VERSION,
    HARNESS_COMMIT,
    NODE_VERSION,
    HARNESS_LICENSE: harnessText('LICENSE'),
    HARNESS_NOTICES: harnessText('THIRD_PARTY_NOTICES.md'),
    NODE_LICENSE: fetchText(`https://raw.githubusercontent.com/nodejs/node/${NODE_VERSION}/LICENSE`),
    RUST_NOTICES: rustNotices(),
    NPM_SUMMARY: npmSummary(),
  }
  for (const [key, value] of Object.entries(subs)) {
    template = template.replaceAll(`{{${key}}}`, value)
  }
  return template
}

function normalizeForCILessCompare(doc) {
  // Strip the npm summary section content: without the closure, CI cannot
  // regenerate it, so the comparison exempts it (release runs are strict).
  const start = doc.indexOf(NPM_SECTION_START)
  if (start === -1) return doc
  return doc.slice(0, start)
}

const generated = render()
if (check) {
  const committed = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
  const hasClosure = existsSync(join(cliDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const genCmp = hasClosure ? generated : normalizeForCILessCompare(generated)
  const comCmp = hasClosure ? committed : normalizeForCILessCompare(committed)
  if (genCmp !== comCmp) {
    console.error('THIRD_PARTY_NOTICES.md is out of date; run: node scripts/gen-third-party-notices.mjs')
    process.exit(1)
  }
  console.log('THIRD_PARTY_NOTICES.md is up to date')
  process.exit(0)
}
writeFileSync(outPath, generated)
console.log(`wrote ${outPath}`)
