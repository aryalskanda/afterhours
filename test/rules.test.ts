// Which of Claude Code's "stop asking" suggestions an app may apply, and how each reads.

import { expect, test } from 'bun:test'
import { suggestionLabel, usableSuggestions } from '../src/daemon/rules'

const inside = (dir: string) => dir.startsWith('/home/me/code')

test('allow rules, accepting edits and shared folders pass; prompt-skipping, deny rules and other folders don’t', () => {
  const raw = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'deny', destination: 'localSettings' },
    { type: 'addDirectories', directories: ['/etc'], destination: 'session' },
    { type: 'addDirectories', directories: ['/home/me/code/shared'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    'junk',
    null,
  ]
  expect(usableSuggestions(raw, inside).map(s => s.type)).toEqual(['addRules', 'addDirectories', 'setMode'])
  expect(usableSuggestions('nope', inside)).toEqual([])
  expect(usableSuggestions(Array(9).fill(raw[0]), inside)).toHaveLength(4)
})

test('each reads as what it does, and where', () => {
  const rule = (toolName: string, ruleContent: string | undefined, destination: string) => ({ type: 'addRules', rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }], behavior: 'allow', destination })
  expect(suggestionLabel(rule('Bash', 'npm test:*', 'localSettings'))).toBe('Always allow commands starting with npm test in this project')
  expect(suggestionLabel(rule('Bash', 'git status', 'session'))).toBe('Always allow the command git status for the rest of this task')
  expect(suggestionLabel(rule('WebFetch', 'domain:docs.expo.dev', 'userSettings'))).toBe('Always allow fetching from docs.expo.dev in every project')
  expect(suggestionLabel(rule('Read', '//home/me/code/shop/docs/**', 'projectSettings'), '/home/me/code/shop')).toBe('Always allow reading docs/** in this project, for everyone on it')
  expect(suggestionLabel(rule('Edit', undefined, 'session'))).toBe('Always allow edits for the rest of this task')
  expect(suggestionLabel({ type: 'setMode', mode: 'acceptEdits', destination: 'session' })).toBe('Accept edits from now on')
  expect(suggestionLabel({ type: 'addDirectories', directories: ['/home/me/code/shared'], destination: 'session' })).toBe('Allow /home/me/code/shared for the rest of this task')
})
