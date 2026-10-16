// When a screen breaks: what went wrong, Try again, and sending it to a machine's owner.

import type { ErrorBoundaryProps } from 'expo-router'
import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { noteProblem } from '../lib/problems'
import { ReportForm } from './Report'
import { Block, Button, Group, Page, Txt } from './ui'

export function CrashScreen(props: ErrorBoundaryProps) {
  useEffect(() => noteProblem(`crash: ${props.error.message}`), [props.error])
  return (
    <SafeAreaProvider>
      <Page title="Something broke" testID="crash">
        <Group footer="Your machines and tasks are fine: this is the app.">
          <Block>
            <Txt mono v="footnote" selectable>
              {props.error.message}
            </Txt>
          </Block>
        </Group>
        <Button title="Try again" kind="tinted" onPress={() => void props.retry()} testID="crash-retry" />
        <ReportForm error={props.error} />
      </Page>
    </SafeAreaProvider>
  )
}
