import { expect, test } from 'bun:test'
import { parseBattery } from '../src/daemon/health'

test('batteries: macOS pmset and Linux sysfs; "discharging" isn’t charging', () => {
  expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t18%; discharging; 1:23 remaining present: true", null)).toEqual({ pct: 18, charging: false })
  expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t96%; charging; 0:20 remaining", null)).toEqual({ pct: 96, charging: true })
  expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining", null)).toEqual({ pct: 100, charging: true })
  expect(parseBattery(null, { capacity: '57\n', status: 'Discharging\n' })).toEqual({ pct: 57, charging: false })
  expect(parseBattery(null, { capacity: '80', status: 'Charging' })).toEqual({ pct: 80, charging: true })
  expect(parseBattery('no battery here', null)).toBeNull()
})
