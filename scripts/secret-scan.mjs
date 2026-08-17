// Local secret scan: fail if private keys, credentials or tokens are about to
// be committed. Runs in CI and before every commit. Not a substitute for
// GitHub secret scanning; a first line of defense only.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const SKIP_DIRS = new Set([
  'node_modules', 'target', 'gen', '.git', '.icon-staging', 'host',
])
const SKIP_FILES = new Set(['package-lock.json', 'Cargo.lock', 'pnpm-lock.yaml'])

const FORBIDDEN_BASENAMES = [
  /\.key$/, /\.key\.pub$/, /\.pem$/, /\.pfx$/, /\.p12$/, /\.cer$/, /\.crt$/,
  /^\.env$/, /^\.env\./,
]

const FORBIDDEN_PATTERNS = [
  // Secret assignments that are NOT CI references (${{ secrets.NAME }}).
  /TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?\s*[:=]\s*(?!\s*\$\{\{)/,
  /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /untrusted comment: minisign encrypted secret key/i,
]

const hits = []

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(p)
      continue
    }
    const rel = relative(root, p).replaceAll('\\', '/')
    if (rel === 'scripts/secret-scan.mjs') continue // the scanner itself
    if (SKIP_FILES.has(entry.name)) continue
    if (FORBIDDEN_BASENAMES.some((re) => re.test(entry.name))) {
      hits.push(`${rel}: forbidden file name`)
      continue
    }
    let text
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    for (const re of FORBIDDEN_PATTERNS) {
      if (re.test(text)) {
        hits.push(`${rel}: matches ${re}`)
        break
      }
    }
  }
}

walk(root)

if (hits.length > 0) {
  console.error('secret scan FAILED:')
  for (const h of hits) console.error(`  ${h}`)
  process.exit(1)
}
console.log('secret scan clean')
