/**
 * Structural contract check.
 *
 * `node --check` only proves a file parses; a plugin also has to keep the
 * exports the Loader and the client module system look for. One destructive
 * edit that deleted the whole `Config` block produced a perfectly valid but
 * unloadable settings page, so these invariants are asserted here.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url)) + path.sep + '..'
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const failures = []
function expect(label, condition) {
  if (!condition) failures.push(label)
}

// --- Host half -------------------------------------------------------------
const host = read('index.js')
for (const marker of [
  'export const name',
  'export const inject',
  'export const Config',
  'export function apply',
]) {
  expect(`index.js keeps ${marker}`, host.includes(marker))
}
expect('index.js declares a schemastery Config', /export const Config = await/.test(host))
expect('index.js keeps the volatile fields', ['installDir', 'timeoutMs', 'useSandbox', 'frontend']
  .every((field) => host.includes(`${field}: z.`)))
expect('index.js serves the config route', host.includes('/api/dsh-wolfram/config'))

// --- Client half -----------------------------------------------------------
const client = read('client.js')
expect('client.js registers a module loader factory', client.includes('window.__ModuleLoader__'))
expect('client.js names the plugin package', client.includes("id: 'dsh-wolfram-renew'"))
expect('client.js waits for a served namespace', client.includes('whileServed'))
expect('client.js registers the bundle page', client.includes("'plugins.bundle.config'"))
expect('client.js leaves the row entry alone', !client.includes("'plugins.row.config'"))

// --- Manifest --------------------------------------------------------------
const pkg = JSON.parse(read('package.json'))
expect('manifest declares dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
expect('manifest declares a web client half', pkg.dsh?.client?.platform === 'web')
expect('manifest exports ./client', typeof pkg.exports?.['./client'] === 'string')
for (const file of ['index.js', 'wolfram.js', 'client.js', 'icon.svg']) {
  expect(`manifest files include ${file}`, (pkg.files ?? []).includes(file))
}
expect('manifest files include the locales', (pkg.files ?? []).includes('locale/*.json'))

// --- Display metadata ------------------------------------------------------
// The displayed name is the package name itself: no product branding.
for (const locale of ['locale/en.json', 'locale/zh.json']) {
  const dictionary = JSON.parse(read(locale))
  expect(`${locale} title is the package name`, dictionary.meta?.title === pkg.name)
  expect(`${locale} description is present`, typeof dictionary.meta?.description === 'string'
    && dictionary.meta.description.length > 0)
}

for (const failure of failures) console.error(`FAIL  ${failure}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} contract check(s) failed`)
  process.exit(1)
}
console.log('contracts OK')
