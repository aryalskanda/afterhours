import { describe, expect, test } from 'bun:test'
import { openBackup, sealBackup, type BackupContents } from './backup'
import { DEFAULT_NOTIFY } from './push'

const cheap = { cost: { N: 2 ** 10, r: 8, p: 1 } }
const contents: BackupContents = {
  identity: 'secret-key-material',
  deviceName: 'Old phone',
  machines: [{ id: 'm1', name: 'build-box', relay: 'wss://relay.example.com/v1', role: 'owner', lastSeq: 40, addedAt: 1 }],
  prefs: { lockApp: true, confirmAllow: false, browserNotifications: false, notify: DEFAULT_NOTIFY, appearance: 'dark', textSize: 'larger' },
  saved: ['Run the tests'],
}

describe('backups', () => {
  test('open with the passphrase; nothing readable without it', async () => {
    const text = await sealBackup(contents, 'correct horse battery', cheap)
    expect(text).not.toContain('secret-key-material')
    expect(text).not.toContain('build-box')
    expect(await openBackup(text, 'correct horse battery')).toEqual(contents)
    await expect(openBackup(text, 'correct horse batterz')).rejects.toThrow('Wrong passphrase, or the backup was changed.')
  })

  test('a changed file, another file, a short passphrase, a file asking for too much', async () => {
    const text = await sealBackup(contents, 'correct horse battery', cheap)
    const sealed = JSON.parse(text)
    const flipped = sealed.data[5] === 'A' ? 'B' : 'A'
    await expect(openBackup(JSON.stringify({ ...sealed, data: sealed.data.slice(0, 5) + flipped + sealed.data.slice(6) }), 'correct horse battery')).rejects.toThrow('Wrong passphrase, or the backup was changed.')
    await expect(openBackup('{"hello":1}', 'correct horse battery')).rejects.toThrow('That isn’t an Afterhours backup')
    await expect(openBackup('not json', 'x')).rejects.toThrow('That isn’t an Afterhours backup.')
    await expect(sealBackup(contents, 'short')).rejects.toThrow('at least 12 characters')
    await expect(openBackup(JSON.stringify({ ...sealed, kdf: { ...sealed.kdf, N: 2 ** 24 } }), 'correct horse battery')).rejects.toThrow('more than this device can do')
  })
})
