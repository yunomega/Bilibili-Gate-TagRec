import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { matchesGlob } from 'node:path'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const config = JSON.parse(await readFile(new URL('turbo.json', root), 'utf8'))
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

for (const task of ['build:vite', 'build:vite-raw']) {
  test(`${task} restores every required distribution artifact from cache`, () => {
    const outputs = config.tasks[task].outputs
    for (const filename of [
      `dist/${pkg.name}.user.js`,
      `dist/${pkg.name}.mini.user.js`,
      `dist/${pkg.name}.meta.js`,
      `dist/${pkg.name}.mini.meta.js`,
      'dist/LICENSE.txt',
      'dist/THIRD_PARTY_NOTICES.txt',
      'dist/release-licenses.json',
    ]) {
      assert.ok(
        outputs.some((glob) => matchesGlob(filename, glob)),
        `${task} does not cache ${filename}`,
      )
    }
  })

  test(`${task} invalidates generated artifacts when licensing or dependencies change`, () => {
    const inputs = config.tasks[task].inputs
    for (const filename of [
      'LICENSE',
      'NOTICE',
      'pnpm-lock.yaml',
      'scripts/release-licenses.mjs',
      'licenses/example.txt',
    ]) {
      assert.ok(
        inputs.some((glob) => matchesGlob(filename, glob)),
        `${task} does not track ${filename}`,
      )
    }
  })
}
