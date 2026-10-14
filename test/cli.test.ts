import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { redact, redactLogLine } from '../src/cli/doctor'
import { homebrewLink } from '../src/cli/install'
import { parseFolderChoice } from '../src/cli/setup'

test('folder choice: numbers, paths, and mistakes', () => {
  const a = mkdtempSync(join(tmpdir(), 'cq-a-'))
  const b = mkdtempSync(join(tmpdir(), 'cq-b-'))
  expect(parseFolderChoice('1', [a, b])).toEqual([a])
  expect(parseFolderChoice('2, 1, 2', [a, b])).toEqual([b, a])
  expect(parseFolderChoice(`1 ${b}`, [a])).toEqual([a, b])
  expect(parseFolderChoice('3', [a, b])).toBe("There's no option 3.")
  expect(parseFolderChoice('/definitely/not/here', [a])).toBe('Not a folder: /definitely/not/here')
  expect(parseFolderChoice('  ', [a])).toBe('Pick at least one folder.')
})

test('report redaction hides bot tokens and your home path', () => {
  const fake = '123456789:AAFakeTokenFakeTokenFakeTokenFake01'
  expect(redact(`token ${fake} in ${homedir()}/x`)).toBe('token <telegram-token> in ~/x')
})

test('report log lines leave out prompts, replies and your name', () => {
  const launched =
    '2026-10-14T10:00:00.000Z launched #3: --resume abc --model opus --effort xhigh --permission-mode plan --settings /x/3.settings.json --name Afterhours: Rotate the staging keys --'
  expect(redactLogLine(launched)).toBe(
    '2026-10-14T10:00:00.000Z launched #3: --resume abc --model opus --effort xhigh --permission-mode plan --settings /x/3.settings.json --name <left out> --',
  )
  expect(redactLogLine('t notice done: ✅ #3 done · “Rotated the keys”')).toBe('t notice done: <text left out>')
  expect(redactLogLine('t telegram: paired with Sam (12345)')).toBe('t telegram: paired with <you>')
})

test('homebrewLink maps a Cellar binary to the link Homebrew keeps current', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'cq-brew-'))
  mkdirSync(join(prefix, 'Cellar', 'afterhours', '0.1.0', 'bin'), { recursive: true })
  mkdirSync(join(prefix, 'bin'))
  writeFileSync(join(prefix, 'bin', 'cq'), '')
  expect(homebrewLink(join(prefix, 'Cellar', 'afterhours', '0.1.0', 'bin', 'cq'))).toBe(join(prefix, 'bin', 'cq'))
  expect(homebrewLink('/Users/me/.afterhours/bin/cq')).toBeNull()
})
