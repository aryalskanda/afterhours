import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { redact, redactLogLine } from '../src/cli/doctor'
import { homebrewLink } from '../src/cli/install'
import { folderPath, parseFolderChoice } from '../src/cli/setup'

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

test('folder choice: a path with spaces, quotes, an escaped space, a trailing slash', () => {
  const root = mkdtempSync(join(tmpdir(), 'cq-sp-'))
  const works = join(root, 'IT Works')
  mkdirSync(join(works, 'AI_class'), { recursive: true })
  const a = mkdtempSync(join(tmpdir(), 'cq-a-'))
  expect(parseFolderChoice(works, [a])).toEqual([works])
  expect(parseFolderChoice(`"${works}"`, [a])).toEqual([works])
  expect(parseFolderChoice(`'${works}'`, [a])).toEqual([works])
  expect(parseFolderChoice(works.replace(/ /g, '\\ '), [a])).toEqual([works])
  expect(parseFolderChoice(`${works}/`, [a])).toEqual([works])
  // Commas separate; a number can sit beside a path with spaces.
  expect(parseFolderChoice(`${works}, 1`, [a])).toEqual([works, a])
  expect(parseFolderChoice(`${join(works, 'AI_class')}, ${works}`, [a])).toEqual([join(works, 'AI_class'), works])
  expect(parseFolderChoice(`${root}/Nope Here`, [a])).toBe(`Not a folder: ${root}/Nope Here`)
})

test('folder choice: Windows paths inside WSL are the same folder under /mnt', () => {
  expect(folderPath('D:\\IT Works', true)).toBe('/mnt/d/IT Works')
  expect(folderPath('D:\\IT Works\\AI_class', true)).toBe('/mnt/d/IT Works/AI_class')
  expect(folderPath("'D:\\IT Works'", true)).toBe('/mnt/d/IT Works')
  expect(folderPath('D:\\', true)).toBe('/mnt/d')
  expect(folderPath('D:', true)).toBe('/mnt/d')
  expect(folderPath('c:/Users/me/code', true)).toBe('/mnt/c/Users/me/code')
  // Not WSL: a drive letter is not a Windows path, so nothing is guessed.
  expect(folderPath('D:\\IT', false)).not.toContain('/mnt/')
  // The message says where it looked.
  expect(parseFolderChoice('D:\\No Such Folder', [], true)).toBe('Not a folder: D:\\No Such Folder (looked for /mnt/d/No Such Folder)')
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
