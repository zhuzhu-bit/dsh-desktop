// CI gate: verify build-support/harness/harness.patch still applies cleanly
// to the pinned Harness commit (cheap: clone metadata + checkout only).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const shell = process.platform === 'win32'
const HARNESS_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'
const HARNESS_COMMIT = process.env.DSH_HARNESS_COMMIT ?? '47f943859bef60e4160492346772ded9b24f765a'
const patch = join(root, 'build-support', 'harness', 'harness.patch')

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell })

const workDir = join(tmpdir(), `dsh-patch-check-${HARNESS_COMMIT.slice(0, 12)}`)
rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })
run('git', ['init', '-q'], workDir)
run('git', ['remote', 'add', 'origin', HARNESS_REPO], workDir)
run('git', ['fetch', '--depth', '1', 'origin', HARNESS_COMMIT], workDir)
run('git', ['checkout', '-q', '--detach', 'FETCH_HEAD'], workDir)
if (!existsSync(patch)) {
  console.error('patch file missing')
  process.exit(1)
}
run('git', ['apply', '--check', patch], workDir)
console.log('harness.patch applies cleanly at the pinned commit')
