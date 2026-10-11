import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import vm from 'node:vm'
import { embedNotices, releaseLicenses, validateDistribution } from './release-licenses.mjs'

const metadata = '// ==UserScript==\n// @version 1.0.9\n// ==/UserScript==\n'
const license = 'MIT License\nCopyright Example\nPermission is hereby granted'
const digest = (text) => createHash('sha256').update(text).digest('hex')
const release = (notices = license, pending = []) => {
  const script = embedNotices(metadata + 'globalThis.ran = true;\n', notices)
  const manifest = { schemaVersion: 1, pending, scriptSha256: digest(script), noticesSha256: digest(notices) }
  return { script, notices, manifest }
}

test('licence text cannot escape comments, including JS line separator characters', () => {
  const notices = `${license}\n*/ globalThis.injected = true; /*\rglobalThis.injected = true;\u{2028}globalThis.injected = true;\u{2029}globalThis.injected = true;`
  const { script, manifest } = release(notices)
  const context = vm.createContext({})
  vm.runInContext(script, context)
  assert.equal(context.ran, true)
  assert.equal(context.injected, undefined)
  assert.ok(script.startsWith(metadata))
  validateDistribution(script, notices, manifest, license)
})

test('missing metadata and repeated notice embedding are rejected', () => {
  assert.throws(() => embedNotices('console.log(1)', license), /metadata/)
  assert.throws(() => embedNotices(release().script, license), /already embedded/)
})

test('pending permissions prevent release even when the artifacts match', () => {
  const { script, notices, manifest } = release(license, ['font: redistribution permission unknown'])
  assert.throws(
    () => validateDistribution(script, notices, manifest, license),
    /font: redistribution permission unknown/,
  )
})

test('a report from another build cannot approve changed script or notices', () => {
  const { script, notices, manifest } = release()
  assert.throws(() => validateDistribution(script + '\n', notices, manifest, license), /does not match/)
  assert.throws(() => validateDistribution(script, notices + '\n', manifest, license), /does not match/)
})

test('a matching manifest still requires embedded third-party notices and project licence', () => {
  const { script, notices, manifest } = release()
  const stripped = metadata + 'globalThis.ran = true;\n'
  assert.throws(
    () => validateDistribution(stripped, notices, { ...manifest, scriptSha256: digest(stripped) }, license),
    /not embedded/,
  )
  assert.throws(() => validateDistribution(script, notices, manifest, 'Another LICENSE'), /Project LICENSE is missing/)
  assert.throws(
    () => validateDistribution(script, notices, { ...manifest, schemaVersion: 2 }, license),
    /Invalid licence manifest/,
  )
  validateDistribution(script, notices, manifest, license)
})

test('collectors see lazy chunks before the userscript plugin removes them', async () => {
  const [collect, distribute] = releaseLicenses()
  assert.equal(collect.generateBundle.order, 'pre')
  assert.equal(distribute.generateBundle.order, 'post')
  // No node_modules on these virtual icon ids: this exercises lazy-chunk collection.
  collect.configResolved({ root: process.cwd() })
  const bundle = {
    entry: { type: 'chunk', moduleIds: ['\0~icons/tabler/reload.jsx'] },
    lazy: { type: 'chunk', moduleIds: ['\0~icons/lets-icons/view-hide.jsx'] },
  }
  await collect.generateBundle.handler({}, bundle)
  const emitted = new Map()
  await distribute.generateBundle.handler.call(
    {
      emitFile(asset) {
        emitted.set(asset.fileName, asset.source)
      },
      warn() {},
    },
    {},
    { script: { type: 'asset', fileName: 'test.user.js', source: metadata + 'console.log(1);\n' } },
  )
  const report = JSON.parse(emitted.get('release-licenses.json'))
  assert.deepEqual(
    report.icons.map((entry) => [entry.name, entry.icons]),
    [
      ['lets-icons', ['view-hide']],
      ['tabler', ['reload']],
    ],
  )
  assert.ok(emitted.get('THIRD_PARTY_NOTICES.txt').includes('Leonid Tsvetkov'))
})
