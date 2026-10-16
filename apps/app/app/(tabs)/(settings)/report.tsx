// Report a problem: what you write, sent to a machine's owner (into its app-reports log).

import { Stack } from 'expo-router'
import { ReportForm } from '../../../src/components/Report'
import { Page } from '../../../src/components/ui'

export default function Report() {
  return (
    <Page testID="report">
      <Stack.Screen options={{ title: 'Report a problem' }} />
      <ReportForm />
    </Page>
  )
}
