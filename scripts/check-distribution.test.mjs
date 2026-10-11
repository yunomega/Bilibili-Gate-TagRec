import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { embedNotices } from './release-licenses.mjs'

const run = promisify(execFile)
const checker = fileURLToPath(new URL('check-distribution.mjs', import.meta.url))
const license = 'MIT License\nCopyright Example\nPermission is hereby granted'
const digest = (text) => createHash('sha256').update(text).digest('hex')

async function fixture(t, fileName, pending = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tagrec-distribution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'dist'))
  const script = embedNotices('// ==UserScript==\n// @version 1.0.0\n// ==/UserScript==\nvoid 0;\n', license)
  const manifest = { schemaVersion: 1, pending, scriptSha256: digest(script), noticesSha256: digest(license) }
  await Promise.all([
    writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tagrec' })),
    writeFile(path.join(root, 'LICENSE'), license),
    writeFile(path.join(root, 'dist', 'LICENSE.txt'), license),
    writeFile(path.join(root, 'dist', 'THIRD_PARTY_NOTICES.txt'), license),
    writeFile(path.join(root, 'dist', 'release-licenses.json'), JSON.stringify(manifest)),
    writeFile(path.join(root, 'dist', fileName), script),
  ])
  return root
}

for (const fileName of ['tagrec.user.js', 'tagrec.mini.user.js']) {
  test(`distribution CLI validates ${fileName}`, async (t) => {
    const root = await fixture(t, fileName)
    const { stdout } = await run(process.execPath, [checker], { cwd: root })
    assert.ok(stdout.includes(`verified: ${fileName}`))
  })
}

test('a stale regular build cannot hide the matching minified artifact', async (t) => {
  const root = await fixture(t, 'tagrec.mini.user.js')
  await writeFile(path.join(root, 'dist', 'tagrec.user.js'), 'stale output from a different build')
  const { stdout } = await run(process.execPath, [checker], { cwd: root })
  assert.ok(stdout.includes('verified: tagrec.mini.user.js'))
})

test('no userscript matching the manifest is a failure, not permission to skip verification', async (t) => {
  const root = await fixture(t, 'tagrec.user.js')
  await writeFile(path.join(root, 'dist', 'tagrec.user.js'), 'stale')
  await assert.rejects(run(process.execPath, [checker], { cwd: root }), /does not match/)
})

test('the distributed project license must exist and match the source', async (t) => {
  const root = await fixture(t, 'tagrec.user.js')
  await rm(path.join(root, 'dist', 'LICENSE.txt'))
  await assert.rejects(run(process.execPath, [checker], { cwd: root }), /LICENSE.txt/)
  await writeFile(path.join(root, 'dist', 'LICENSE.txt'), 'outdated license')
  await assert.rejects(run(process.execPath, [checker], { cwd: root }), /LICENSE.txt/)
})

test('pending licence review still blocks an otherwise matching minified build', async (t) => {
  const root = await fixture(t, 'tagrec.mini.user.js', ['resource: review required'])
  await assert.rejects(run(process.execPath, [checker], { cwd: root }), /review required/)
})
