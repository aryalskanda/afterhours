// What machines send back for each request, checked before the app uses it: an older or newer
// machine may send something this version doesn't expect.

import { ChatInfo, DeviceInfo, JobInfo } from '@afterhours/protocol'
import { z } from 'zod'

export { TaskDetail } from '@afterhours/protocol'

export const ChatList = z.object({ chats: z.array(ChatInfo), more: z.boolean() })
export const FolderList = z.array(z.object({ path: z.string(), name: z.string(), isRepo: z.boolean().optional() }))
export type FolderHit = z.infer<typeof FolderList>[number]
/** `peek`: the running task's screen; null when nothing is running. */
export const ScreenText = z.object({ job: z.number(), text: z.string() }).nullable()
export const DeviceList = z.array(DeviceInfo)
/** `queue` and `chat.write`: the task that was queued. */
export const Queued = z.object({ job: JobInfo })

export const UNREADABLE = 'The machine sent something this version of the app doesn’t understand. Update the app or Afterhours on the machine.'
