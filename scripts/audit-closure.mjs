// Audit the deployed dsh runtime closure: find every `@deepseek-ai/*` package
// referenced by the deployed package files (root lib/config + every
// node_modules/@deepseek-ai/* package's files) that is NOT itself present
// under node_modules/@deepseek-ai/, and print the source dir of each missing
// package so the fix loop can add file: deps mechanically.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const TARGET = 'E:/code/deepseek/work_space/dsh-desktop/src-tauri/resources/host/cli'
const REPO = 'E:/code/deepseek/deepseek-harness'
const REF_RE = /@deepseek-ai\/([a-z0-9-]+)/g

// 1. Package name -> source dir (harness repo workspaces).
const nameToDir = new Map()
for (const root of [join(REPO, 'packages'), join(REPO, 'vendor'), join(REPO, 'apps'), join(REPO, 'native', 'landlock-run', 'packages')]) {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const p = join(dir, entry.name)
      try {
        const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8'))
        if (pkg.name?.startsWith('@deepseek-ai/')) nameToDir.set(pkg.name, p)
        else walk(p, depth + 1)
      } catch { walk(p, depth + 1) }
    }
  }
  walk(root, 0)
}

// 2. Scan targets: root (except node_modules) + node_modules/@deepseek-ai/*.
// Only RUNTIME-load surfaces count: JS bundles and cordis patch YAMLs.
// Lockfiles and package.json manifests are resolution metadata — they list
// the whole workspace (peers/optionals/dev deps), not what the web profile
// actually loads — so they are excluded.
const referenced = new Set()
const isScanTarget = (name) =>
  /\.(js|mjs|cjs|yml|yaml)$/.test(name) &&
  !/^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(name)
const scan = (dir) => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) { scan(p); continue }
    if (!isScanTarget(entry.name)) continue
    let text
    try { text = readFileSync(p, 'utf8') } catch { continue }
    for (const m of text.matchAll(REF_RE)) referenced.add(m[1])
  }
}
const skipNodeModules = (dir) => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      scan(p)
    } else if (isScanTarget(entry.name)) {
      let text
      try { text = readFileSync(p, 'utf8') } catch { continue }
      for (const m of text.matchAll(REF_RE)) referenced.add(m[1])
    }
  }
}
skipNodeModules(TARGET)
const dshRoot = join(TARGET, 'node_modules', '@deepseek-ai')
for (const entry of readdirSync(dshRoot, { withFileTypes: true })) {
  if (entry.isDirectory()) scan(join(dshRoot, entry.name))
}

// 3. Present set.
const present = new Set(readdirSync(dshRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name))

// Known non-gaps: test-support packages referenced from comments/docs,
// Linux-only optional landlock packages, the deploy-root manifest's own
// name, package names that only exist in prose (not in the repo), and regex
// artifacts of line-wrapped strings (trailing '-').
const ALLOWED_MISSING = new Set([
  'dsh-agent-loop-testkit',
  'dsh-client-test-runtime',
  'dsh-llm-mock-server',
  'dsh-loader-smoke',
  'dsh-desktop-deploy-root',
  'dsh-client-app-shell',
  'dsh-timeout-guard',
  'dsh-tool-read',
  'dsh-tool-web-search',
  'node-addon-landlock-run-linux-arm64',
  'node-addon-landlock-run-linux-x64',
])
const isAllowed = (name) =>
  ALLOWED_MISSING.has(name) || name.endsWith('-')

const missing = [...referenced].filter((n) => !present.has(n)).sort()
const realMissing = missing.filter((n) => !isAllowed(n))
console.log(`referenced: ${referenced.size}, present: ${present.size}`)
if (missing.length === 0) {
  console.log('NO GAPS — closure complete')
} else {
  console.log(`missing total: ${missing.length} (${realMissing.length} real)`)
  for (const name of missing) {
    const dir = nameToDir.get(`@deepseek-ai/${name}`)
    console.log(`  ${isAllowed(name) ? '[allowed]' : '[REAL GAP]'} ${name}  <-  ${dir ?? '(source dir not found in repo)'}`)
  }
}
if (realMissing.length > 0) {
  console.error(`audit-closure: ${realMissing.length} real gaps — fix the deploy-root manifest`)
  process.exit(1)
}
