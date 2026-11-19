import { describe, expect, test } from 'bun:test'
import { planFromScreen } from '../src/daemon/runner'
import { addDirDialog, choosePlanOption, exitSelected, feedbackOption, planDialog, trustDialog } from '../src/daemon/screens'
import { ADD_DIR_SCREEN, PLAN_SCREEN, TRUST_SCREEN, TRUST_SCREEN_YES } from './fixtures'

describe('trust dialog', () => {
  test('detected with focus on "No, exit"', () => {
    expect(trustDialog(TRUST_SCREEN)).toEqual({ present: true, yesFocused: false })
  })

  test('after Down the yes option is focused', () => {
    expect(trustDialog(TRUST_SCREEN_YES)).toEqual({ present: true, yesFocused: true })
  })

  test('not on other screens', () => {
    expect(trustDialog(PLAN_SCREEN).present).toBe(false)
  })
})

describe('add-folder dialog', () => {
  test('detected with the folder it asks about, focus on "No, exit"', () => {
    expect(addDirDialog(ADD_DIR_SCREEN)).toEqual({ present: true, dir: '/Users/me/.afterhours/uploads', yesFocused: false })
    expect(exitSelected(ADD_DIR_SCREEN)).toBe(true)
  })

  test('after Down "Yes, add it" is focused', () => {
    const yes = ADD_DIR_SCREEN.replace(' ❯ No, exit', '   No, exit').replace('   Yes, add it', ' ❯ Yes, add it')
    expect(addDirDialog(yes)).toMatchObject({ present: true, yesFocused: true })
    expect(exitSelected(yes)).toBe(false)
  })

  test('not the project trust dialog, nor other screens', () => {
    expect(addDirDialog(TRUST_SCREEN).present).toBe(false)
    expect(addDirDialog(PLAN_SCREEN).present).toBe(false)
    expect(trustDialog(ADD_DIR_SCREEN).present).toBe(false)
  })
})

describe('plan dialog', () => {
  const dialog = planDialog(PLAN_SCREEN)

  test('options parsed in order with focus', () => {
    expect(dialog.present).toBe(true)
    expect(dialog.options).toEqual([
      { n: 1, label: 'Yes, and use auto mode', focused: true },
      { n: 2, label: 'Yes, manually approve edits', focused: false },
      { n: 3, label: 'Tell Claude what to change', focused: false },
    ])
  })

  test('auto mode is picked directly', () => {
    expect(choosePlanOption(dialog.options, 'auto')).toEqual({ option: dialog.options[0]! })
  })

  test('a mode the dialog lacks: approve manually, switch afterwards', () => {
    expect(choosePlanOption(dialog.options, 'acceptEdits')).toEqual({ option: dialog.options[1]!, switchAfter: 'acceptEdits' })
    expect(choosePlanOption(dialog.options, 'bypassPermissions')?.switchAfter).toBe('bypassPermissions')
  })

  test('feedback option', () => {
    expect(feedbackOption(dialog.options)?.n).toBe(3)
  })

  test('plan text from the screen', () => {
    expect(planFromScreen(PLAN_SCREEN)).toBe('Create hello.txt in the repo root containing the word "hi".')
  })

  test('not on the trust screen', () => {
    expect(planDialog(TRUST_SCREEN).present).toBe(false)
  })
})
