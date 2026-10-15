// The one hub the app uses, its storage, and the hooks screens read it with.

import type { ChatInfo } from '@afterhours/protocol'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Platform } from 'react-native'
import { desktop, desktopPlatform } from './desktop'
import { Hub, type HubState, type Storage } from './lib/hub'
import type { MachineState } from './lib/state'

const local = {
  get: async (key: string) => globalThis.localStorage?.getItem(key) ?? null,
  set: async (key: string, value: string) => globalThis.localStorage?.setItem(key, value),
}

/**
 * The key lives in the Keychain / Keystore, on this device only (never in a backup); on the
 * desktop, encrypted by the OS. A plain browser has no keychain: there it's in the site's storage,
 * which Settings says.
 */
const bridge = desktop
const storage: Storage = bridge
  ? { getSecret: key => bridge.secrets.get(key), setSecret: (key, value) => bridge.secrets.set(key, value), get: local.get, set: local.set }
  : Platform.OS === 'web'
    ? { getSecret: local.get, setSecret: local.set, get: local.get, set: local.set }
    : {
        getSecret: key => SecureStore.getItemAsync(key),
        setSecret: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
        get: key => AsyncStorage.getItem(key),
        set: (key, value) => AsyncStorage.setItem(key, value),
      }

function defaultName(): string {
  if (desktop?.info.deviceName) return desktop.info.deviceName
  const named = Constants.deviceName?.trim()
  if (named) return named
  return Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'Web browser'
}

export const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0'

export const hub = new Hub({
  storage,
  defaultName: defaultName(),
  platform: desktopPlatform ?? Platform.OS,
  app: `afterhours-app/${APP_VERSION}`,
})

export function useHub(): HubState {
  return useSyncExternalStore(hub.subscribe, hub.getState, hub.getState)
}

export function useMachine(id: string | undefined): MachineState | undefined {
  const state = useHub()
  return state.machines.find(m => m.id === id)
}

/** The time, re-read every `ms`, for running clocks. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/** Chats the Chats tab listed, so a chat's screen can show it at once (it asks again anyway). */
export const chatCache = new Map<string, ChatInfo>()
