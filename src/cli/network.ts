// `cq network`: whether Afterhours reconnects the Wi-Fi by itself when it drops, and which saved
// networks it tries first.

import { wifiSystem } from '../platform/network'
import { loadConfig, saveConfig } from '../shared/config'

const USAGE = 'Usage: cq network [status] | cq network reconnect on|off | cq network prefer "<network>" … | cq network prefer none'

export async function networkCommand(args: string[]): Promise<boolean> {
  const config = loadConfig()
  const [sub, ...rest] = args
  if (sub === undefined || sub === 'status') {
    const wifi = wifiSystem()
    const device = wifi ? await wifi.device() : null
    if (!device) {
      console.log('No Wi-Fi here, so there is nothing to reconnect.')
      return true
    }
    console.log(`When the Wi-Fi drops: ${config.network.reconnect ? 'Afterhours reconnects it after a minute (Wi-Fi off and on, then the saved networks)' : 'left alone (cq network reconnect on to change)'}`)
    const saved = await wifi!.saved(device)
    if (saved.length > 0) console.log(`Saved networks: ${saved.join(', ')}`)
    if (config.network.prefer.length > 0) console.log(`Tried first: ${config.network.prefer.join(', ')}`)
    return true
  }
  if (sub === 'reconnect' && (rest[0] === 'on' || rest[0] === 'off')) {
    saveConfig({ ...config, network: { ...config.network, reconnect: rest[0] === 'on' } })
    console.log(rest[0] === 'on' ? 'When the Wi-Fi drops, Afterhours reconnects it after a minute.' : 'Afterhours leaves the Wi-Fi alone.')
    return true
  }
  if (sub === 'prefer' && rest.length > 0) {
    const prefer = rest.length === 1 && rest[0] === 'none' ? [] : rest
    saveConfig({ ...config, network: { ...config.network, prefer } })
    console.log(prefer.length > 0 ? `Tried first when reconnecting: ${prefer.join(', ')}` : 'No network is tried first.')
    return true
  }
  console.error(USAGE)
  return false
}
