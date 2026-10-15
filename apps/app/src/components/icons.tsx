// The app's icons: vector, so they look the same on every phone, the web and the desktop (emoji
// depend on the fonts a device has).

import type { ApprovalInfo, JobInfo, Notice } from '@afterhours/protocol'
import Ionicons from '@expo/vector-icons/Ionicons'
import type { ColorValue } from 'react-native'

export type IconName = keyof typeof Ionicons.glyphMap

export function Icon(props: { name: IconName; color: ColorValue; size?: number }) {
  return <Ionicons name={props.name} color={props.color} size={props.size ?? 18} />
}

export const KIND_ICON: Record<ApprovalInfo['kind'], IconName> = {
  permission: 'lock-closed',
  question: 'help-circle',
  review: 'document-text',
  trust: 'shield-checkmark',
}

export const STATUS_ICON: Record<JobInfo['status'], IconName> = {
  queued: 'time-outline',
  running: 'play-circle',
  held: 'pause-circle',
  done: 'checkmark-circle',
  failed: 'close-circle',
  cancelled: 'remove-circle-outline',
}

export const NOTICE_ICON: Record<Notice['type'], IconName> = {
  started: 'play-circle-outline',
  plan_approved: 'checkmark-done-outline',
  plan_review: 'document-text-outline',
  permission: 'lock-closed-outline',
  question: 'help-circle-outline',
  trust: 'shield-checkmark-outline',
  limit: 'hourglass-outline',
  resumed: 'play-forward-outline',
  done: 'checkmark-circle-outline',
  held: 'pause-circle-outline',
  failed: 'alert-circle-outline',
  conflict: 'git-compare-outline',
  took_over: 'swap-horizontal-outline',
  session_limit: 'hourglass-outline',
  chat_continue: 'chatbubble-ellipses-outline',
  recovered: 'refresh-outline',
  setup_warning: 'warning-outline',
  empty: 'checkmark-done-outline',
  resolved: 'checkmark-outline',
}
