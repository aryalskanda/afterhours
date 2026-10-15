import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autostartEntry, autostartPath } from '../src/autostart'
import { checkCount, checkNotice, checkRoute, checkSecretKey, checkSecretValue } from '../src/inputs'
import { cleanLink, findLink } from '../src/links'
import { SecretStore, type Cipher } from '../src/secrets'
import { allowPermission, CONTENT_SECURITY_POLICY, contentType, fileFor, isAppUrl, isSafeExternal } from '../src/security'

describe('what the window may load and open', () => {
  test('pages of the app, and nothing else, are the app', () => {
    expect(isAppUrl('app://afterhours/')).toBe(true)
    expect(isAppUrl('app://afterhours/machine/x/task/12?a=1')).toBe(true)
    expect(isAppUrl('app://evil/')).toBe(false)
    expect(isAppUrl('https://afterhours/')).toBe(false)
    expect(isAppUrl('file:///etc/passwd')).toBe(false)
    expect(isAppUrl('not a url')).toBe(false)
  })

  test('only web pages open in the browser', () => {
    expect(isSafeExternal('https://claude.com/claude-code')).toBe(true)
    expect(isSafeExternal('http://localhost:3000')).toBe(true)
    expect(isSafeExternal('file:///Applications/Calculator.app')).toBe(false)
    expect(isSafeExternal('smb://share/x')).toBe(false)
    expect(isSafeExternal('javascript:alert(1)')).toBe(false)
    expect(isSafeExternal('https://user:pass@example.com')).toBe(false)
  })

  test('notifications and the clipboard, for the app only', () => {
    expect(allowPermission('notifications', 'app://afterhours/')).toBe(true)
    expect(allowPermission('clipboard-read', 'app://afterhours/pair')).toBe(true)
    expect(allowPermission('loopback-network', 'app://afterhours/')).toBe(true)
    expect(allowPermission('media', 'app://afterhours/')).toBe(false)
    expect(allowPermission('geolocation', 'app://afterhours/')).toBe(false)
    expect(allowPermission('notifications', 'https://example.com/')).toBe(false)
  })

  test('the policy keeps code and pages to the app', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval')
    expect(CONTENT_SECURITY_POLICY).toContain('connect-src')
  })

  test('app:// paths map to files inside the web build only', () => {
    expect(fileFor('app://afterhours/', '/app/web')).toBe('/app/web')
    expect(fileFor('app://afterhours/_expo/static/js/web/index.js', '/app/web')).toBe('/app/web/_expo/static/js/web/index.js')
    expect(fileFor('app://afterhours/inbox?x=1', '/app/web')).toBe('/app/web/inbox')
    expect(fileFor('app://afterhours/../secrets.json', '/app/web')).toBe('/app/web/secrets.json')
    // The URL parser resolves dot segments (encoded ones too) before any file is named.
    expect(fileFor('app://afterhours/a/%2e%2e/%2e%2e/etc/passwd', '/app/web')).toBe('/app/web/etc/passwd')
    expect(fileFor('app://afterhours/a%5c..%5c..%5cwin.ini', 'C:\\app\\web', '\\')).toBeNull()
    expect(fileFor('app://afterhours/C:/Windows/win.ini', 'C:\\app\\web', '\\')).toBeNull()
    expect(fileFor('app://afterhours/x%00.js', '/app/web')).toBeNull()
    expect(fileFor('app://other/index.html', '/app/web')).toBeNull()
    expect(fileFor('app://afterhours/assets/icon.png', 'C:\\app\\web\\', '\\')).toBe('C:\\app\\web\\assets\\icon.png')
  })

  test('content types', () => {
    expect(contentType('/w/index.html')).toBe('text/html; charset=utf-8')
    expect(contentType('/w/a.JS')).toBe('text/javascript; charset=utf-8')
    expect(contentType('/w/Ionicons.ttf')).toBe('font/ttf')
    expect(contentType('/w/README')).toBe('application/octet-stream')
  })
})

describe('afterhours:// links', () => {
  const link = 'afterhours://pair?r=wss%3A%2F%2Frelay.example.com%2Fv1&m=abc&s=def&n=build-box&x=1900000000'

  test('found among the arguments a launch gets', () => {
    expect(findLink(['/Applications/Afterhours.app/Contents/MacOS/Afterhours', '--hidden'])).toBeNull()
    expect(findLink(['C:\\Program Files\\Afterhours\\Afterhours.exe', '--allow-file-access-from-files', link])).toBe(link)
    expect(findLink(['afterhours', 'AFTERHOURS://pair?r=x'])).toBe('afterhours://pair?r=x')
  })

  test('nothing odd gets through', () => {
    expect(cleanLink('https://afterhours.dev/pair')).toBeNull()
    expect(cleanLink('afterhours://pair?x=1 --inspect')).toBeNull()
    expect(cleanLink('afterhours://pair?x=\u0007')).toBeNull()
    expect(cleanLink(`afterhours://pair?${'a'.repeat(5000)}`)).toBeNull()
  })
})

describe('what the window sends is checked', () => {
  test('secret names and values', () => {
    expect(checkSecretKey('afterhours.identity')).toBe('afterhours.identity')
    expect(() => checkSecretKey('../../etc')).toThrow()
    expect(() => checkSecretKey('__proto__')).toThrow()
    expect(() => checkSecretKey(42)).toThrow()
    expect(() => checkSecretValue('x'.repeat(70_000))).toThrow()
  })

  test('routes stay inside the app', () => {
    expect(checkRoute('/inbox')).toBe('/inbox')
    expect(checkRoute('/machine/abc_DEF-123')).toBe('/machine/abc_DEF-123')
    expect(() => checkRoute('https://evil.example')).toThrow()
    expect(() => checkRoute('//evil.example/x')).toThrow()
    expect(() => checkRoute('/a b')).toThrow()
  })

  test('notifications are trimmed to one line each', () => {
    expect(checkNotice({ title: 'build-box', body: '#14 wants\nto use Bash', route: '/inbox' })).toEqual({ title: 'build-box', body: '#14 wants to use Bash', route: '/inbox' })
    expect(checkNotice({ title: '', body: 'x', route: '/' }).title).toBe('Afterhours')
    expect(checkNotice({ title: 'x'.repeat(500), body: 'y'.repeat(1000), route: '/' }).body.length).toBe(300)
    expect(() => checkNotice({ title: 'x', body: 'y', route: 'javascript:1' })).toThrow()
    expect(() => checkNotice(null)).toThrow()
  })

  test('counts', () => {
    expect(checkCount(3)).toBe(3)
    expect(checkCount(5000)).toBe(999)
    expect(() => checkCount(-1)).toThrow()
    expect(() => checkCount(1.5)).toThrow()
    expect(() => checkCount('3')).toThrow()
  })
})

describe('the secret store', () => {
  const xor: Cipher = {
    protected: true,
    encrypt: text => Buffer.from([...Buffer.from(text, 'utf8')].map(b => b ^ 0x5a)),
    decrypt: data => Buffer.from([...data].map(b => b ^ 0x5a)).toString('utf8'),
  }

  test('values are encrypted on disk, and read back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-secrets-'))
    try {
      const file = join(dir, 'secrets.json')
      new SecretStore(file, xor).set('afterhours.identity', 'the-private-key')
      const raw = readFileSync(file, 'utf8')
      expect(raw).not.toContain('the-private-key')
      expect(Buffer.from(JSON.parse(raw).items['afterhours.identity'].data, 'base64').toString()).not.toContain('private')
      expect(new SecretStore(file, xor).get('afterhours.identity')).toBe('the-private-key')
      expect(new SecretStore(file, xor).get('afterhours.other')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('without a keyring, values are kept as they are, and the store says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-secrets-'))
    try {
      const plain: Cipher = { protected: false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }
      const store = new SecretStore(join(dir, 'secrets.json'), plain)
      store.set('afterhours.identity', 'k')
      expect(store.protected).toBe(false)
      expect(new SecretStore(join(dir, 'secrets.json'), plain).get('afterhours.identity')).toBe('k')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a value the OS can no longer decrypt reads as missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-secrets-'))
    try {
      const file = join(dir, 'secrets.json')
      new SecretStore(file, xor).set('afterhours.identity', 'k')
      const broken: Cipher = { ...xor, decrypt: () => { throw new Error('no key') } }
      const lines: string[] = []
      expect(new SecretStore(file, broken, l => lines.push(l)).get('afterhours.identity')).toBeNull()
      expect(lines.join()).toContain("can't decrypt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('start at login on Linux', () => {
  test('an autostart entry that starts hidden', () => {
    expect(autostartPath('/home/me', '')).toBe('/home/me/.config/autostart/dev.afterhours.app.desktop')
    expect(autostartPath('/home/me', '/xdg')).toBe('/xdg/autostart/dev.afterhours.app.desktop')
    const entry = autostartEntry('/home/me/Apps/Afterhours "1".AppImage')
    expect(entry).toContain('Exec="/home/me/Apps/Afterhours \\"1\\".AppImage" --hidden')
    expect(entry).toContain('[Desktop Entry]')
  })
})
