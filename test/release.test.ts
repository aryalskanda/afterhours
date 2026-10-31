import { expect, test } from 'bun:test'
import { checksummedNames, CHECKSUMMED, missingAssets, nextVersion, REQUIRED_ASSETS, withVersion } from '../scripts/release'

test('the next version: a bump word, or an exact newer version', () => {
  expect(nextVersion('0.6.0', 'patch')).toBe('0.6.1')
  expect(nextVersion('0.6.3', 'minor')).toBe('0.7.0')
  expect(nextVersion('0.6.3', 'major')).toBe('1.0.0')
  expect(nextVersion('0.9.0', '0.10.0')).toBe('0.10.0')
  expect(nextVersion('0.9.0', 'v1.2.3')).toBe('1.2.3')
  // Not newer, not a version, or not a choice.
  expect(nextVersion('0.6.0', '0.6.0')).toBeNull()
  expect(nextVersion('0.10.0', '0.9.9')).toBeNull()
  expect(nextVersion('0.6.0', '1.0')).toBeNull()
  expect(nextVersion('0.6.0', 'huge')).toBeNull()
})

test('a release must have every build, the checksums and both installers', () => {
  expect(REQUIRED_ASSETS).toEqual(expect.arrayContaining(['cq-darwin-arm64', 'cq-darwin-x64', 'cq-linux-arm64', 'cq-linux-x64', 'cq-windows-x64.exe', 'SHA256SUMS', 'install.sh', 'install.ps1']))
  expect(missingAssets(REQUIRED_ASSETS)).toEqual([])
  expect(missingAssets(REQUIRED_ASSETS.filter(a => a !== 'cq-windows-x64.exe' && a !== 'install.ps1'))).toEqual(['cq-windows-x64.exe', 'install.ps1'])
})

test('checksums: the names SHA256SUMS lists', () => {
  const sum = 'a'.repeat(64)
  const sums = CHECKSUMMED.map(name => `${sum}  ${name}`).join('\n') + '\n'
  expect(checksummedNames(sums)).toEqual(CHECKSUMMED)
  expect(missingAssets(checksummedNames(sums.replace(/.*windows.*\n/, '')), CHECKSUMMED)).toEqual(['cq-windows-x64.exe'])
  expect(checksummedNames(`${sum} *cq-linux-x64\nnot a line\n`)).toEqual(['cq-linux-x64'])
})

test('the version bump changes only the version line', () => {
  const text = '{\n  "name": "x",\n  "version": "0.6.0",\n  "dependencies": { "a": "1.0.0" }\n}\n'
  expect(withVersion(text, '0.7.0')).toBe(text.replace('0.6.0', '0.7.0'))
  expect(() => withVersion('{}', '1.0.0')).toThrow('no version')
})
