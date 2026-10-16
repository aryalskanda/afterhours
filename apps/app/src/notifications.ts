// Push notifications on a phone: asking to send them, this device's Expo push token, how they show
// while the app is in front (they don't: the banner does), their buttons (Allow and Deny on a
// permission, Approve on a plan), and what tapping one opens. Browsers and the desktop app show
// their own notifications instead (see Overlays).

import Constants from 'expo-constants'
import * as LocalAuthentication from 'expo-local-authentication'
import * as Notifications from 'expo-notifications'
import { router, type Href } from 'expo-router'
import { AppState, Platform } from 'react-native'
import { hub } from './app-state'
import { plainReply } from './lib/format'
import { pushAnswer, pushData, pushRoute } from './lib/push'

export const pushAvailable = Platform.OS === 'ios' || Platform.OS === 'android'

/** The Expo project the app is built under: pushes go through it, so it needs your Expo account. */
export function pushProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null
}

export const NEEDS_ACCOUNT = 'Push needs the app built under an Expo account. Until then, Needs you and the banner show what waits on you.'

/** Asks to send notifications, and gets this device's push token; says why not when it can't. */
export async function enablePush(o: { ask: boolean } = { ask: true }): Promise<{ token: string } | { error: string }> {
  const projectId = pushProjectId()
  if (!projectId) return { error: NEEDS_ACCOUNT }
  try {
    const current = await Notifications.getPermissionsAsync()
    const granted = current.granted || (o.ask && (await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })).granted)
    if (!granted) return { error: 'Notifications are off for Afterhours in the phone’s Settings.' }
    return { token: (await Notifications.getExpoPushTokenAsync({ projectId })).data }
  } catch (err) {
    return { error: `No push token: ${err instanceof Error ? err.message : err}` }
  }
}

/** Answers from a notification's button, or opens what it's about. */
async function respond(r: Notifications.NotificationResponse): Promise<void> {
  const data = pushData(r.notification.request.content.data)
  if (!data) return
  await hub.init()
  const body = pushAnswer(r.actionIdentifier, data)
  if (!body) {
    router.push(pushRoute(data) as Href)
    return
  }
  // With Confirm Allow on, Face ID first, as in the app.
  if (body.decision === 'allow' && hub.getState().prefs.confirmAllow && (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync())) {
    const auth = await LocalAuthentication.authenticateAsync({ promptMessage: 'Allow it?' })
    if (!auth.success) {
      router.push('/inbox')
      return
    }
  }
  const result = await hub.request(data.machine, body, { timeoutMs: 20_000 })
  hub.tell(data.machine, plainReply(result.ok ? (result.text ?? 'Done.') : (result.error ?? 'It didn’t go through.')))
  router.push((result.ok && data.job !== null ? `/machine/${data.machine}/task/${data.job}` : '/inbox') as Href)
}

/** Takes down a request's notification once it's answered anywhere. */
async function dismiss(machine: string, code: string): Promise<void> {
  for (const n of await Notifications.getPresentedNotificationsAsync()) {
    const d = pushData(n.request.content.data)
    if (d?.machine === machine && d.code === code) await Notifications.dismissNotificationAsync(n.request.identifier)
  }
}

/** Starts handling notifications; call once, when the app starts. */
export function startNotifications(): () => void {
  if (!pushAvailable) return () => {}
  Notifications.setNotificationHandler({
    handleNotification: async () => {
      const front = AppState.currentState === 'active'
      return { shouldShowBanner: !front, shouldShowList: true, shouldPlaySound: !front, shouldSetBadge: false }
    },
  })
  const quietly = (p: Promise<unknown>) => void p.catch(() => {})
  quietly(
    Notifications.setNotificationCategoryAsync('permission', [
      { identifier: 'allow', buttonTitle: 'Allow', options: { opensAppToForeground: true, isAuthenticationRequired: true } },
      { identifier: 'deny', buttonTitle: 'Deny', options: { opensAppToForeground: true, isDestructive: true } },
    ]),
  )
  quietly(Notifications.setNotificationCategoryAsync('plan', [{ identifier: 'approve', buttonTitle: 'Approve', options: { opensAppToForeground: true, isAuthenticationRequired: true } }]))
  if (Platform.OS === 'android') {
    quietly(Notifications.setNotificationChannelAsync('requests', { name: 'Requests', importance: Notifications.AndroidImportance.HIGH }))
    quietly(Notifications.setNotificationChannelAsync('updates', { name: 'Finished and failed tasks', importance: Notifications.AndroidImportance.DEFAULT }))
  }
  const handled = new Set<string>()
  const onResponse = (r: Notifications.NotificationResponse) => {
    const key = `${r.notification.request.identifier}:${r.actionIdentifier}`
    if (handled.has(key)) return
    handled.add(key)
    void respond(r).finally(() => quietly(Notifications.clearLastNotificationResponseAsync()))
  }
  const sub = Notifications.addNotificationResponseReceivedListener(onResponse)
  // Opened from a notification: the response that started the app.
  quietly(Notifications.getLastNotificationResponseAsync().then(r => r && onResponse(r)))
  const off = hub.onNews(n => {
    if (n.type === 'resolved' && n.code) quietly(dismiss(n.machine, n.code))
  })
  // The token can change (a restore, a reinstall): machines get the new one.
  quietly(
    hub.init().then(async () => {
      if (!hub.getState().push.token) return
      const r = await enablePush({ ask: false })
      if ('token' in r && r.token !== hub.getState().push.token) await hub.setPush(r.token)
    }),
  )
  return () => {
    sub.remove()
    off()
  }
}
