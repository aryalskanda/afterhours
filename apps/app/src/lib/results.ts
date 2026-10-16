// What machines send back for each request, checked before the app uses it: an older or newer
// machine may send something this version doesn't expect.

import { AuditEntryInfo, ChatInfo, DeviceInfo, Event, JobInfo, LimitSample } from '@afterhours/protocol'
import { z } from 'zod'

export { ClaudeInfo, DiffSummary, FilePatch, FilesResult, HealthInfo, TaskDetail, TranscriptPage } from '@afterhours/protocol'
import { SlashCommand } from '@afterhours/protocol'

export const ChatList = z.object({ chats: z.array(ChatInfo), more: z.boolean() })
export const FolderList = z.array(z.object({ path: z.string(), name: z.string(), isRepo: z.boolean().optional() }))
export type FolderHit = z.infer<typeof FolderList>[number]
/** `peek`: the running task's screen; null when nothing is running. */
export const ScreenText = z.object({ job: z.number(), text: z.string() }).nullable()
export const DeviceList = z.array(DeviceInfo)
/** `queue` and `chat.write`: the task that was queued. */
export const Queued = z.object({ job: JobInfo })
/** `commands`: the slash commands and skills a folder's tasks can use. */
export const SlashCommandList = z.object({ commands: z.array(SlashCommand) })
/** `upload`: where the file was put on the machine. */
export const Uploaded = z.object({ path: z.string() })
/** `timeline`: every notice about one task. */
export const Timeline = z.object({ events: z.array(Event) })
/** `jobs`: the queue, and finished tasks newest first; `more` when older ones match too. */
export const Jobs = z.object({ active: JobInfo.nullable(), queued: z.array(JobInfo), recent: z.array(JobInfo), more: z.boolean().optional() })
/** `limits.history`: the usage limits as the machine sampled them over the last week. */
export const LimitHistory = z.object({ samples: z.array(LimitSample) })
/** `audit`: what devices did on the machine, newest first. */
export const AuditList = z.object({ entries: z.array(AuditEntryInfo) })
/** `pair.offer`: a pairing link for another device, until `expires`. */
export const Offer = z.object({ link: z.string(), expires: z.number() })

export const UNREADABLE = 'The machine sent something this version of the app doesn’t understand. Update the app or Afterhours on the machine.'
