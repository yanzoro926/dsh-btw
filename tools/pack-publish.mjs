// Build the npm release copy of this plugin.
//
// The repository package is named `dsh-btw` for the local dev install
// (the desktop profile pins it with a file: dependency and a Junction).
// That name is already taken on npm by an unrelated project, so the
// published package is `dsh-btw-plugin`. The only differences are the
// package name and the bundle patch's insert name; everything else is
// copied verbatim from the repository.
//
// Usage:
//   node tools/pack-publish.mjs          # stage the renamed copy in .publish
//   cd .publish && npm pack --pack-destination dist
//   cd .publish && npm publish --access public
//
// The staged directory is disposable; never edit it by hand.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stage = path.join(root, '.publish')

const FILES = ['lib', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'package.json']

await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
for (const name of FILES) {
  await cp(path.join(root, name), path.join(stage, name), { recursive: true })
}

const pkgPath = path.join(stage, 'package.json')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
pkg.name = 'dsh-btw-plugin'
pkg.private = false
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

const patchPath = path.join(stage, 'cordis.patch.yml')
let patch = await readFile(patchPath, 'utf8')
patch = patch.replace(/(\n\s+name:\s*)dsh-btw(\s*\n)/, '$1dsh-btw-plugin$2')
await writeFile(patchPath, patch, 'utf8')

const readmePath = path.join(stage, 'README.md')
let readme = await readFile(readmePath, 'utf8')
readme = readme.replace(/^# dsh-btw\n/u, '# dsh-btw（npm 包名：dsh-btw-plugin）\n')
await writeFile(readmePath, readme, 'utf8')

execFileSafe()

function execFileSafe() {
  // Keep the pack step in the caller's shell: Node child_process pipes are
  // blocked under the Windows sandbox (EPERM), and npm.cmd needs cmd.exe.
  console.log(`\nStaged ${pkg.name}@${pkg.version} in ${stage}`)
  console.log(`Pack:    cd ${stage} && npm pack --pack-destination dist`)
  console.log('Publish: cd .publish && npm publish --access public')
}
