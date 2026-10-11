import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { validateDistribution } from './release-licenses.mjs'

async function checkDistribution() {
  const root = process.cwd()
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const [notices, manifest, license, distributedLicense] = await Promise.all([
    readFile(path.join(root, 'dist', 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
    readFile(path.join(root, 'dist', 'release-licenses.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'LICENSE'), 'utf8'),
    readFile(path.join(root, 'dist', 'LICENSE.txt'), 'utf8'),
  ])
  if (distributedLicense !== license) throw new Error('Distributed LICENSE.txt does not match the project LICENSE')

  // [tag-rec] Default local builds are minified. KEEP_DIST may also leave an older
  // variant behind: only the artifact whose hash matches this manifest can pass.
  const errors = []
  for (const fileName of [`${pkg.name}.user.js`, `${pkg.name}.mini.user.js`]) {
    let script
    try {
      script = await readFile(path.join(root, 'dist', fileName), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    try {
      validateDistribution(script, notices, manifest, license)
      return fileName
    } catch (error) {
      errors.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(errors.length ? errors.join('\n') : `No userscript artifact found in dist for ${pkg.name}`)
}

try {
  console.log(`Distribution notices verified: ${await checkDistribution()}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
