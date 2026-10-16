// What the end-to-end runs share: the exported web build served locally, and headless Chrome with
// helpers that find what's on screen by test id (screens under the top one stay in the page,
// hidden, so only visible matches count).

import { mkdirSync } from 'node:fs'
import { join, normalize } from 'node:path'
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export function serveWeb(dist = join(import.meta.dir, '..', 'dist-web')) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = normalize(join(dist, decodeURIComponent(new URL(req.url).pathname)))
      if (!path.startsWith(dist)) return new Response('Not here', { status: 403 })
      const file = Bun.file(path)
      // One page app: any address that isn't a file is the app.
      return new Response(!path.endsWith('/') && (await file.exists()) ? file : Bun.file(join(dist, 'index.html')))
    },
  })
}

export interface Driver {
  browser: Browser
  page: Page
  /** Errors the page logged or threw (React DevTools' hint aside). */
  errors(): string[]
  visible(id: string, timeout?: number): Promise<ElementHandle<Element>>
  tap(id: string): Promise<void>
  typeInto(id: string, text: string): Promise<void>
  /** Replaces a field's text. */
  replace(id: string, text: string): Promise<void>
  /** Text on the page (case aside: section titles are uppercased by their style). */
  see(text: string, timeout?: number): Promise<void>
  gone(id: string, timeout?: number): Promise<void>
  /** The header's back button, as a person would go back (the web's history differs with tabs). */
  back(): Promise<void>
  shot(name: string): Promise<void>
  /** Controls a screen reader can't name (buttons, switches, radios, fields, menu items), as role: nearby text. */
  unnamed(): Promise<string[]>
  check(name: string, run: () => Promise<void>): Promise<void>
  failed(): boolean
}

/** Headless Chrome, at a phone's size. */
export async function drive(out: string): Promise<Driver> {
  // CI runners' Chrome can't use its sandbox.
  const args = ['--no-first-run', '--no-default-browser-check', ...(process.env.CI ? ['--no-sandbox'] : [])]
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args })
  const page = await browser.newPage()
  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 })
  return attach(browser, page, out)
}

/** A browser that's already running (the desktop app, through its debugging port): its page at `url`. */
export async function connect(browserURL: string, url: (u: string) => boolean, out: string): Promise<Driver> {
  const browser = await puppeteer.connect({ browserURL, defaultViewport: null })
  const target = await browser.waitForTarget(t => t.type() === 'page' && url(t.url()), { timeout: 20_000 })
  const page = await target.page()
  if (!page) throw new Error('no page')
  return attach(browser, page, out)
}

export function attach(browser: Browser, page: Page, out: string): Driver {
  mkdirSync(out, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', err => errors.push(String(err)))
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  const sel = (id: string) => `[data-testid="${id}"]`
  let step = 0
  let failed = false

  const d: Driver = {
    browser,
    page,
    errors: () => errors.filter(e => !/Download the React DevTools|favicon/.test(e)),
    async visible(id, timeout = 10_000) {
      const handle = await page
        .waitForFunction(
          (s: string) => [...document.querySelectorAll(s)].find(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden') ?? false,
          // Timed polling: animation frames stop in a window that's behind another one.
          { timeout, polling: 100 },
          sel(id),
        )
        .catch(() => {
          throw new Error(`${id} never showed`)
        })
      const el = handle.asElement()
      if (!el) throw new Error(`no ${id}`)
      return el as ElementHandle<Element>
    },
    async tap(id) {
      await (await d.visible(id)).click()
    },
    async typeInto(id, text) {
      const el = await d.visible(id)
      await el.click()
      await el.type(text)
    },
    async replace(id, text) {
      const el = await d.visible(id)
      await el.click()
      await el.evaluate(input => (input as HTMLInputElement).select())
      await el.type(text)
    },
    async see(text, timeout = 10_000) {
      await page.waitForFunction((t: string) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout, polling: 100 }, text).catch(() => {
        throw new Error(`"${text}" never showed`)
      })
    },
    async gone(id, timeout = 10_000) {
      await page.waitForFunction((s: string) => ![...document.querySelectorAll(s)].some(el => el.getClientRects().length > 0), { timeout, polling: 100 }, sel(id))
    },
    async back() {
      const handle = await page
        .waitForFunction(
          () => [...document.querySelectorAll('[aria-label$=", back"], [aria-label="Go back"], [data-testid="header-back"]')].find(el => el.getClientRects().length > 0) ?? false,
          { timeout: 10_000, polling: 100 },
        )
        .catch(() => {
          throw new Error('no back button')
        })
      await (handle.asElement() as ElementHandle<Element>).click()
    },
    async unnamed() {
      const tree = await page.accessibility.snapshot({ interestingOnly: true })
      const roles = new Set(['button', 'switch', 'radio', 'checkbox', 'link', 'menuitem', 'textbox', 'combobox', 'slider', 'tab'])
      const out: string[] = []
      const walk = (n: { role?: string; name?: string; children?: unknown[] }, parent: string) => {
        if (n.role && roles.has(n.role) && !(n.name ?? '').trim()) out.push(`${n.role} in "${parent.slice(0, 60)}"`)
        for (const child of (n.children ?? []) as (typeof n)[]) walk(child, n.name || parent)
      }
      if (tree) walk(tree, '')
      return out
    },
    async shot(name) {
      await page.screenshot({ path: join(out, `${name}.png`) })
    },
    async check(name, run) {
      step++
      const started = Date.now()
      try {
        await run()
        console.log(`✓ ${step}. ${name} (${Date.now() - started}ms)`)
      } catch (err) {
        failed = true
        console.log(`✗ ${step}. ${name}: ${err instanceof Error ? err.message : err}`)
        const recent = d.errors().slice(-5)
        if (recent.length > 0) console.log(`  page errors:\n    ${recent.map(e => e.slice(0, 400)).join('\n    ')}`)
        console.log(`  at ${page.url()}`)
        await page.screenshot({ path: join(out, `failed-${step}.png`) }).catch(() => {})
        throw err
      }
    },
    failed: () => failed || d.errors().length > 0,
  }
  return d
}

export async function until<T>(find: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const found = await find()
    if (found) return found
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}
