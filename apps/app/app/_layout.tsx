// The app's frame: starts the hub and notifications, checks the connections when the app comes
// back to the foreground, themes the navigation, and lays the banner and the lock over every screen.

import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider, type ErrorBoundaryProps, type Href } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { Appearance, AppState, Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { hub, useHub } from '../src/app-state'
import { CrashScreen } from '../src/components/Crash'
import { MenuHost } from '../src/components/Menu'
import { AttentionBanner, LockGate, SystemAlerts } from '../src/components/Overlays'
import { desktop } from '../src/desktop'
import { useStackOptions } from '../src/navigation'
import { startNotifications } from '../src/notifications'
import { useTheme } from '../src/theme'

void SplashScreen.preventAutoHideAsync().catch(() => {})

// A link that opens a screen directly (afterhours://pair?…) still has the tabs to go back to.
export const unstable_settings = { initialRouteName: '(tabs)' }

/** A screen that throws: what broke, Try again, and a report to a machine's owner. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <CrashScreen {...props} />
}

export default function Root() {
  const { c, dark, wide } = useTheme()
  const stack = useStackOptions()
  const { ready, prefs } = useHub()

  // Native pieces (alerts, keyboards, pickers) follow the app's light or dark too.
  useEffect(() => {
    if (Platform.OS !== 'web') Appearance.setColorScheme(prefs.appearance === 'system' ? 'unspecified' : prefs.appearance)
  }, [prefs.appearance])

  useEffect(() => {
    void hub.init()
    const stopNotifications = startNotifications()
    // Whatever happens, the splash doesn't stay up.
    const timer = setTimeout(() => void SplashScreen.hideAsync().catch(() => {}), 4000)
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') hub.wake()
      else if (s === 'background') hub.leave()
    })
    return () => {
      clearTimeout(timer)
      sub.remove()
      stopNotifications()
    }
  }, [])

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {})
  }, [ready])

  // The desktop app: afterhours:// links open pairing; a notification or the tray opens a screen.
  useEffect(() => {
    if (!desktop) return
    const offLink = desktop.onLink(link => {
      const q = link.indexOf('?')
      router.push({ pathname: '/pair', params: Object.fromEntries(new URLSearchParams(q >= 0 ? link.slice(q + 1) : '')) })
    })
    const offRoute = desktop.onNavigate(route => router.push(route as Href))
    return () => {
      offLink()
      offRoute()
    }
  }, [])

  const base = dark ? DarkTheme : DefaultTheme
  const theme = { ...base, colors: { ...base.colors, primary: c.accent, background: c.page, card: c.page, text: c.ink, border: c.line, notification: c.accent } }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider value={theme}>
          <Stack screenOptions={stack}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Machines' }} />
            <Stack.Screen name="pair" options={{ presentation: 'modal', title: 'Pair a machine', headerTitleAlign: wide ? 'center' : undefined }} />
            <Stack.Screen name="new" options={{ presentation: 'modal', title: 'New task', headerTitleAlign: wide ? 'center' : undefined }} />
          </Stack>
          <AttentionBanner />
          <SystemAlerts />
          <MenuHost />
          <LockGate />
          <StatusBar style={dark ? 'light' : 'dark'} />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
