// Copies the app's web build (apps/app/dist-web) into web/, where the desktop app serves it from.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = join(here, '..', '..', 'app', 'dist-web')
const to = join(here, '..', 'web')
if (!existsSync(join(from, 'index.html'))) {
  console.error(`No web build at ${from}. Run: npm --prefix ../app run export:web`)
  process.exit(1)
}
rmSync(to, { recursive: true, force: true })
cpSync(from, to, { recursive: true })
console.log(`Copied the web build to ${to}`)
