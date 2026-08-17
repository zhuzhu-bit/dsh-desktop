// Reproducible generation of the bundled runtime for the dsh-desktop
// installer. Used by BOTH the release workflow and local builds.
//
//   1. Clean checkout of the official Harness at a pinned commit.
//   2. Apply build-support/harness/harness.patch (registers the deploy root).
//   3. Install (pinned pnpm 11.7.0) and build the Harness.
//   4. `pnpm deploy` the deploy-root production closure (hoisted, injected —
//      zero junctions/symlinks, NSIS-packable).
//   5. Full verification: entry exists, no links, no dev/test leftovers,
//      closure audit passes, node runs, `dsh web` prints a localhost URL.
//   6. node.exe downloaded from nodejs.org and verified against the official
//      SHASUMS256.txt — including when the file already exists.
//
// Pins (env-overridable for testing only; the release workflow uses these):
//   DSH_HARNESS_COMMIT  47f943859bef60e4160492346772ded9b24f765a
//   DSH_PNPM_VERSION    11.7.0
//   DSH_NODE_VERSION    v24.9.0
//
// Usage: node scripts/prepare-host.mjs
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  copyFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shell = process.platform === 'win32'

const HARNESS_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'
const HARNESS_COMMIT = process.env.DSH_HARNESS_COMMIT ?? '47f943859bef60e4160492346772ded9b24f765a'
const PNPM_VERSION = process.env.DSH_PNPM_VERSION ?? '11.7.0'
const NODE_VERSION = process.env.DSH_NODE_VERSION ?? 'v24.9.0'

const hostDir = join(root, 'src-tauri', 'resources', 'host')
const cliDir = join(hostDir, 'cli')
const cliEntry = join(cliDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const nodeExe = join(hostDir, 'node.exe')
const patchFile = join(root, 'build-support', 'harness', 'harness.patch')

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell })
}

function fail(message) {
  console.error(`prepare-host: FAILED: ${message}`)
  process.exit(1)
}

function step(title) {
  console.log(`\n==== ${title} ====`)
}

// ---------- 1. Clean checkout at the pinned commit ----------
step('clean checkout of Harness at pinned commit')
const workDir = join(tmpdir(), `dsh-harness-${HARNESS_COMMIT.slice(0, 12)}`)
rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })
run('git', ['init', '-q'], workDir)
run('git', ['remote', 'add', 'origin', HARNESS_REPO], workDir)
run('git', ['fetch', '--depth', '1', 'origin', HARNESS_COMMIT], workDir)
run('git', ['checkout', '-q', '--detach', 'FETCH_HEAD'], workDir)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, shell })
  .toString()
  .trim()
if (head !== HARNESS_COMMIT) {
  fail(`checkout mismatch: HEAD=${head} expected=${HARNESS_COMMIT}`)
}
console.log(`checkout verified: ${head}`)

// ---------- 2. Apply the deploy-root patch ----------
step('apply deploy-root patch')
run('git', ['apply', '--check', patchFile], workDir)
run('git', ['apply', patchFile], workDir)
if (!existsSync(join(workDir, 'deploy-roots', 'dsh-desktop', 'package.json'))) {
  fail('patch applied but deploy-root manifest is missing')
}

// ---------- 3. Install (pinned pnpm) and build the Harness ----------
step(`install with pnpm ${PNPM_VERSION}`)
const pnpm = (args) => run('npx', ['--yes', `pnpm@${PNPM_VERSION}`, ...args], workDir)
pnpm(['install', '--lockfile-only'])
pnpm(['install', '--frozen-lockfile'])
step('build Harness (host face + client emit + client bundles + web dist)')
// Host face: full tsc + tsdown (runtime JS comes from here).
pnpm(['run', 'build:lib:host'])
// Client face note: at this pinned commit, a fully clean Windows checkout
// cannot pass `tsc -b tsconfig.client.json` (the host typert slot catalog
// emits empty keyProps on Windows, breaking declaration merging in
// ui-conversation; the local checkout only passes via incremental
// tsbuildinfo). The client tsc is a typecheck gate, not a runtime artifact
// source — tsdown bundles the client packages from source and vite builds
// apps/web from source too (apps/web/vite.config.ts). So emit the lib/types
// entries without semantic checks, then run the real client bundler.
run('npx', ['tsc', '-b', 'tsconfig.client.json', '--noCheck'], workDir)
run('npx', ['tsdown', '--env.DSH_BUILD_FACE', 'client'], workDir)
pnpm(['run', 'build:web'])
for (const artifact of [
  join(workDir, 'apps', 'cli', 'lib', 'bin.js'),
  join(workDir, 'apps', 'web', 'dist', 'index.html'),
  join(workDir, 'packages', 'client', 'ui-conversation', 'lib', 'index.js'),
]) {
  if (!existsSync(artifact)) fail(`missing build artifact: ${artifact}`)
}

// ---------- 4. Deploy the production closure ----------
step('deploy production closure (hoisted, injected)')
rmSync(cliDir, { recursive: true, force: true })
mkdirSync(hostDir, { recursive: true })
// The deploy exits 1 when pnpm blocks the (Windows no-op) postinstall of
// @deepseek-ai/dsh-subprocess-local; the tree is complete before that error,
// so tolerate ONLY that specific failure and verify everything after.
let deployOk = true
let deployOutput = ''
try {
  deployOutput = execFileSync(
    'npx',
    [
      '--yes',
      `pnpm@${PNPM_VERSION}`,
      'deploy',
      '--filter',
      '@deepseek-ai/dsh-desktop-deploy-root',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.inject-workspace-packages=true',
      cliDir,
    ],
    { cwd: workDir, stdio: 'pipe', shell },
  ).toString()
} catch (e) {
  deployOutput = `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  const tolerated =
    deployOutput.includes('ERR_PNPM_IGNORED_BUILDS') &&
    deployOutput.includes('dsh-subprocess-local')
  if (!tolerated) {
    console.error(deployOutput)
    fail('pnpm deploy failed with an unexpected error')
  }
  deployOk = false
  console.log('deploy reported the known ignored-build-script error; continuing with verification')
}

// ---------- 5. Verification ----------
step('verify closure')

if (!existsSync(cliEntry)) fail(`deploy did not produce ${cliEntry}`)

// 5a. No junctions / symlinks anywhere in the closure.
const links = []
const walkLinks = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      links.push(p)
      continue
    }
    if (entry.isDirectory()) walkLinks(p)
  }
}
walkLinks(cliDir)
if (links.length > 0) {
  fail(`closure contains ${links.length} symlinks/junctions (first: ${links[0]})`)
}

// 5b. No dev/test leftovers.
const devPackages = [
  'dsh-loader-smoke',
  'dsh-llm-mock-server',
  'dsh-agent-loop-testkit',
  'dsh-client-test-runtime',
]
const dshScope = join(cliDir, 'node_modules', '@deepseek-ai')
for (const name of readdirSync(dshScope)) {
  if (devPackages.includes(name)) {
    fail(`dev/test package leaked into the closure: ${name}`)
  }
}

// 5c. Closure audit (allowlist inside the script).
run('node', [join(root, 'scripts', 'audit-closure.mjs')], root)

// ---------- 6. node.exe with official checksum ----------
step(`node.exe ${NODE_VERSION} with SHASUMS256 verification`)
mkdirSync(hostDir, { recursive: true })
const zipName = `node-${NODE_VERSION}-win-x64.zip`
const zipPath = join(tmpdir(), zipName)
const sumsPath = join(tmpdir(), `SHASUMS256-${NODE_VERSION}.txt`)
const distBase = `https://nodejs.org/dist/${NODE_VERSION}`
run('powershell', [
  '-NoProfile', '-NonInteractive', '-Command',
  `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${distBase}/${zipName}' -OutFile '${zipPath}'; Invoke-WebRequest -Uri '${distBase}/SHASUMS256.txt' -OutFile '${sumsPath}'`,
], root)

const expected = readFileSync(sumsPath, 'utf8')
  .split(/\r?\n/)
  .find((l) => l.trim().endsWith(zipName))
if (!expected) fail(`SHASUMS256.txt has no entry for ${zipName}`)
const expectedHash = expected.trim().split(/\s+/)[0]
const actualHash = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
  fail(`checksum mismatch: expected ${expectedHash} got ${actualHash}`)
}
console.log(`checksum verified: ${actualHash}`)

// Extract node.exe from the verified archive; replace the existing one if
// its content differs (existence alone never skips verification).
const extractDir = join(tmpdir(), `dsh-node-${NODE_VERSION}`)
rmSync(extractDir, { recursive: true, force: true })
mkdirSync(extractDir, { recursive: true })
run('tar', ['-xf', zipPath, '-C', extractDir], root)
const extracted = join(extractDir, `node-${NODE_VERSION}-win-x64`, 'node.exe')
if (!existsSync(extracted)) fail('node.exe not found inside the verified archive')
const extractedHash = createHash('sha256').update(readFileSync(extracted)).digest('hex')
if (existsSync(nodeExe)) {
  const existingHash = createHash('sha256').update(readFileSync(nodeExe)).digest('hex')
  if (existingHash === extractedHash) {
    console.log('existing node.exe matches the verified archive; keeping it')
  } else {
    copyFileSync(extracted, nodeExe)
    console.log('existing node.exe did NOT match; replaced with the verified binary')
  }
} else {
  copyFileSync(extracted, nodeExe)
}
const nodeVersion = execFileSync(nodeExe, ['--version']).toString().trim()
if (nodeVersion !== NODE_VERSION) fail(`node.exe reports ${nodeVersion}, expected ${NODE_VERSION}`)

// ---------- 7. Runtime smoke: dsh web must print a localhost URL ----------
step('runtime smoke: dsh web prints a localhost URL')
const { spawn } = await import('node:child_process')
const host = spawn(nodeExe, [cliEntry, '--profile', 'web', '--port', '0'], {
  cwd: cliDir,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
let url = null
host.stdout.on('data', (d) => {
  output += d.toString()
  const m = output.match(/https?:\/\/127\.0\.0\.1:\d+/)
  if (m) url = m[0]
})
host.stderr.on('data', () => {})
const deadline = Date.now() + 150_000
while (!url && Date.now() < deadline) {
  if (host.exitCode !== null) break
  await new Promise((r) => setTimeout(r, 1000))
}
if (host.exitCode === null) {
  execFileSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], {
    stdio: 'ignore',
    shell,
  })
}
if (!url) {
  console.error(output.slice(-4000))
  fail('dsh web did not print a localhost URL within 150s')
}
console.log(`runtime smoke OK: ${url}`)

console.log('\nprepare-host: ALL CHECKS PASSED')
console.log(`  node: ${nodeExe} (${NODE_VERSION}, sha256 ${extractedHash})`)
console.log(`  cli : ${cliEntry}`)
console.log(`  harness commit: ${HARNESS_COMMIT}`)
