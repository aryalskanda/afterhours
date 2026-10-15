// The app's frame: starts the hub, checks the connections when the app comes back to the
// foreground, themes the navigation, and lays the banner and the lock over every screen.

import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider, type Href } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { AppState, useColorScheme } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { hub, useHub } from '../src/app-state'
import { AttentionBanner, LockGate, SystemAlerts } from '../src/components/Overlays'
import { desktop } from '../src/desktop'
import { palette } from '../src/theme'

void SplashScreen.preventAutoHideAsync().catch(() => {})

// A link that opens a screen directly (afterhours://pair?…) still has the tabs to go back to.
export const unstable_settings = { initialRouteName: '(tabs)' }

export default function Root() {
  const dark = useColorScheme() === 'dark'
  const c = dark ? palette.dark : palette.light
  const { ready } = useHub()

  useEffect(() => {
    void hub.init()
    // Whatever happens, the splash doesn't stay up.
    const timer = setTimeout(() => void SplashScreen.hideAsync().catch(() => {}), 4000)
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') hub.wake()
    })
    return () => {
      clearTimeout(timer)
      sub.remove()
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
  const theme = { ...base, colors: { ...base.colors, primary: c.accent, background: c.bg, card: c.card, text: c.ink, border: c.line, notification: c.accent } }

  return (
    <SafeAreaProvider>
      <ThemeProvider value={theme}>
        <Stack
          screenOptions={{
            headerTintColor: c.accent,
            headerTitleStyle: { color: c.ink },
            headerStyle: { backgroundColor: c.card },
            contentStyle: { backgroundColor: c.bg },
            headerBackButtonDisplayMode: 'minimal',
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Machines' }} />
          <Stack.Screen name="pair" options={{ presentation: 'modal', title: 'Pair a machine' }} />
          <Stack.Screen name="new" options={{ presentation: 'modal', title: 'New task' }} />
        </Stack>
        <AttentionBanner />
        <SystemAlerts />
        <LockGate />
        <StatusBar style="auto" />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
