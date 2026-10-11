import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const noticeMarker = 'TagRec distribution notices'
const externalPackages = ['axios', 'ua-parser-js', 'localforage', 'pinyin-match', 'spark-md5']
const supportedLicenses = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  '(WTFPL OR MIT)',
])
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const normalize = (text) => text.replaceAll(/\r\n?|\u{2028}|\u{2029}/gu, '\n').trim()

export function embedNotices(script, notices) {
  const end = /^\/\/[ \t]*==\/UserScript==[ \t]*(?:\r?\n|$)/m
  if (!end.test(script)) throw new Error('Missing userscript metadata terminator')
  if (script.includes(noticeMarker)) throw new Error('Distribution notices are already embedded')
  // Line comments preserve licence text containing */ and cannot introduce executable code.
  const comment = `// ${noticeMarker}\n${normalize(notices)
    .split('\n')
    .map((line) => `// ${line}`)
    .join('\n')}\n\n`
  return script.replace(end, (match) => match + comment)
}

export function validateDistribution(script, notices, manifest, expectedLicense) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.pending)) {
    throw new Error('Invalid licence manifest')
  }
  if (manifest.pending.length) throw new Error(`Unresolved release licences:\n${manifest.pending.join('\n')}`)
  if (manifest.noticesSha256 !== sha256(notices) || manifest.scriptSha256 !== sha256(script)) {
    throw new Error('Licence manifest does not match the release artifacts')
  }
  const comment = normalize(notices)
    .split('\n')
    .map((line) => `// ${line}`)
    .join('\n')
  if (!script.includes(`// ${noticeMarker}\n${comment}\n`)) throw new Error('Third-party notices are not embedded')
  if (!normalize(notices).includes(normalize(expectedLicense))) throw new Error('Project LICENSE is missing')
}

async function packageAt(file) {
  let dir = path.dirname(file.split('?', 1)[0])
  for (;;) {
    try {
      const data = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
      if (data.name && data.version) return { dir, data }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`Cannot identify package for ${file}`)
    dir = parent
  }
}

async function packageNotice({ dir, data }, overrides, pending) {
  const key = `${data.name}@${data.version}`
  const override = overrides.packages[key]
  const identifier = override?.identifier ?? data.license
  const files = (await readdir(dir, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice|copyright)(?:notice)?(?:$|[._-])/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
  const texts = await Promise.all(
    files.map(async (file) => `--- ${file} ---\n${normalize(await readFile(path.join(dir, file), 'utf8'))}`),
  )
  if (!supportedLicenses.has(identifier))
    pending.push(`${key}: licence identifier is missing or needs review (${identifier ?? 'unknown'})`)
  if (!texts.length && !override?.text) pending.push(`${key}: no licence text supplied`)
  if (
    identifier === 'MIT' &&
    texts.length &&
    !override?.text &&
    !texts.some((text) => text.includes('Permission is hereby granted'))
  ) {
    pending.push(`${key}: incomplete MIT licence text`)
  }
  if (identifier === 'Apache-2.0' && !texts.some((text) => text.includes('TERMS AND CONDITIONS'))) {
    pending.push(`${key}: incomplete Apache-2.0 licence text`)
  }
  if (override) texts.push(`--- Source review ---\n${override.source}\n${override.explanation}\n${override.text}`)
  return {
    name: data.name,
    version: data.version,
    identifier,
    source: `https://www.npmjs.com/package/${data.name}/v/${data.version}`,
    text: texts.join('\n\n'),
  }
}

async function loadReviewTexts(root, overrides) {
  const licenseRoot = path.join(root, 'licenses')
  for (const entry of [
    ...Object.values(overrides.packages),
    ...Object.values(overrides.icons),
    ...(overrides.projectNotices ?? []),
  ]) {
    if (!entry.textFile) continue
    const file = path.resolve(licenseRoot, entry.textFile)
    const relative = path.relative(licenseRoot, file)
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Licence text must stay inside licenses/')
    const text = await readFile(file, 'utf8')
    if (entry.sha256 && entry.sha256 !== sha256(text.replaceAll('\r\n', '\n')))
      throw new Error(`Reviewed licence text changed: ${entry.textFile}`)
    entry.text = normalize(text)
  }
}

function renderNotices(projectLicense, projectNotices, packages, icons, manual) {
  return (
    [
      '# TagRec distribution notices',
      'The project uses the following separately licensed components. Their original licences continue to apply.',
      `## Project licence\n\n${normalize(projectLicense)}`,
      ...projectNotices.map((entry) => `## ${entry.name}\n\nSource: ${entry.source}\n\n${entry.text}`),
      ...packages.map(
        (entry) =>
          `## ${entry.name}@${entry.version} (${entry.identifier ?? 'unconfirmed'})\n\nSource: ${entry.source}\n\n${entry.text}`,
      ),
      ...icons.map(
        (entry) =>
          `## Icons: ${entry.name} (${entry.identifier})\n\nAuthor: ${entry.author}\nSource: ${entry.source}\nLicence: ${entry.licenseUrl}\nUsed icons: ${entry.icons.join(', ')}\nChanges: SVG data compiled into React components; display size and colour follow the interface.\n\n${entry.text ?? 'Original licence text is pending review.'}`,
      ),
      ...manual.map((entry) => `## Manual resource: ${entry.name}\n\nSource: ${entry.source}\n${entry.explanation}`),
    ].join('\n\n') + '\n'
  )
}

/** Capture the original module graph before vite-plugin-monkey merges/removes chunks. */
export function releaseLicenses() {
  let root
  let packages
  let iconNames
  let moduleIds
  return [
    {
      name: 'tagrec:collect-licenses',
      apply: 'build',
      enforce: 'pre',
      configResolved(config) {
        root = config.root
      },
      generateBundle: {
        order: 'pre',
        async handler(_options, bundle) {
          packages = new Map()
          iconNames = new Map()
          moduleIds = new Set()
          for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk') continue
            for (const id of chunk.moduleIds) {
              moduleIds.add(id.replaceAll('\\', '/'))
              const icon = id.match(/~icons\/([^/]+)\/([^?]+)/)
              if (icon) {
                const names = iconNames.get(icon[1]) ?? new Set()
                names.add(icon[2].replace(/\.jsx?$/, ''))
                iconNames.set(icon[1], names)
              }
              if (!id.startsWith('\0') && /[/\\]node_modules[/\\]/.test(id)) {
                const pkg = await packageAt(id)
                packages.set(`${pkg.data.name}@${pkg.data.version}`, pkg)
              }
            }
          }
        },
      },
    },
    {
      name: 'tagrec:distribute-licenses',
      apply: 'build',
      enforce: 'post',
      generateBundle: {
        order: 'post',
        async handler(_options, bundle) {
          const require = createRequire(path.join(root, 'package.json'))
          const overrides = JSON.parse(await readFile(path.join(root, 'licenses/overrides.json'), 'utf8'))
          await loadReviewTexts(root, overrides)
          const pending = []
          const scripts = Object.values(bundle).filter((file) => file.fileName.endsWith('.user.js'))
          if (scripts.length !== 1) throw new Error('Expected exactly one userscript release artifact')
          const output = scripts[0]
          const script = output.type === 'chunk' ? output.code : output.source.toString()
          const added = new Set(['vite-plugin-monkey']) // generated runtime helpers
          if (script.includes('System.register(')) added.add('systemjs')
          for (const name of externalPackages) {
            if (new RegExp(`^//\\s*@require\\s+.*[/@]${name.replaceAll('-', '\\-')}[/@]`, 'm').test(script))
              added.add(name)
          }
          for (const name of added) {
            const owner = name === 'systemjs' ? createRequire(require.resolve('vite-plugin-monkey')) : require
            const pkg = await packageAt(owner.resolve(name))
            packages.set(`${pkg.data.name}@${pkg.data.version}`, pkg)
          }
          const entries = await Promise.all([...packages.values()].map((pkg) => packageNotice(pkg, overrides, pending)))
          entries.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))
          const icons = []
          const iconDataVersion = require('@iconify/json/package.json').version
          for (const [prefix, names] of [...iconNames].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
            const { info } = require(`@iconify/json/json/${prefix}.json`)
            const review = overrides.icons[prefix]
            if (!review || review.dataVersion !== iconDataVersion || review.identifier !== info.license.spdx) {
              pending.push(`icons/${prefix}: original licence text needs review for @iconify/json@${iconDataVersion}`)
            }
            icons.push({
              name: prefix,
              author: info.author.name,
              identifier: info.license.spdx,
              source: info.author.url,
              licenseUrl: review?.source ?? info.license.url,
              icons: [...names].sort(),
              text: review?.text,
            })
          }
          const manual = overrides.resources.filter((resource) =>
            [...moduleIds].some((id) => id.endsWith(`/${resource.file}`)),
          )
          for (const resource of manual) if (resource.pending) pending.push(`${resource.name}: ${resource.pending}`)
          const projectLicense = await readFile(path.join(root, 'LICENSE'), 'utf8')
          const notices = renderNotices(projectLicense, overrides.projectNotices ?? [], entries, icons, manual)
          const licensedScript = embedNotices(script, notices)
          if (output.type === 'chunk') output.code = licensedScript
          else output.source = licensedScript
          const manifest = {
            schemaVersion: 1,
            noticesSha256: sha256(notices),
            scriptSha256: sha256(licensedScript),
            packages: entries.map(({ text, ...entry }) => entry),
            icons: icons.map(({ text, ...entry }) => entry),
            pending: pending.sort(),
          }
          for (const [fileName, source] of [
            ['LICENSE.txt', projectLicense],
            ['THIRD_PARTY_NOTICES.txt', notices],
            ['release-licenses.json', JSON.stringify(manifest, null, 2) + '\n'],
          ])
            this.emitFile({ type: 'asset', fileName, source })
          if (pending.length)
            this.warn(
              `Release licence review is incomplete (${pending.length} items). Local build is available; deployment must pass validateDistribution.`,
            )
        },
      },
    },
  ]
}
