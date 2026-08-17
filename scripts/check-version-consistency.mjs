// Gate: package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json must
// carry exactly the same version. Optional argv[2] = expected version (the
// release workflow passes the git tag). Exit 1 on any mismatch.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const cargoToml = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')
const cargoMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)
const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))

const versions = {
  'package.json': pkg.version,
  'src-tauri/Cargo.toml': cargoMatch?.[1],
  'src-tauri/tauri.conf.json': conf.version,
}
const expected = process.argv[2]

const values = Object.entries(versions)
const ok =
  values.every(([, v]) => v !== undefined) &&
  values.every(([, v]) => v === values[0][1]) &&
  (expected === undefined || values[0][1] === expected)

for (const [file, v] of values) console.log(`  ${file} = ${v}`)
if (expected !== undefined) console.log(`  expected  = ${expected}`)
if (!ok) {
  console.error('version mismatch — fix all three files before releasing')
  process.exit(1)
}
console.log('versions consistent')
