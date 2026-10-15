#!/usr/bin/env bun
// A command-line Afterhours app: pairs with machines and drives them through the relay, end-to-end
// encrypted, exactly as the phone and desktop apps will. For testing until those exist.
//
//   bun scripts/remote-client.ts pair '<link from cq pair>' [--name "My laptop"]
//   bun scripts/remote-client.ts status build-box
//   bun scripts/remote-client.ts queue build-box ~/code/shop "Add a dark mode toggle" --mode edits
//   bun scripts/remote-client.ts watch
//
// Its key and paired machines live in --state <dir> (default ~/.afterhours-client).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AppClient,
  decodeIdentity,
  encodeIdentity,
  fingerprint,
  newIdentity,
  peerId,
  type Identity,
  type MachineConnection,
  type MachineRecord,
  type QueueOptions,
  type Result,
  type Snapshot,
} from '@afterhours/protocol'

const USAGE = `Usage: bun scripts/remote-client.ts [--state <dir>] <command>

  pair <link> [--name <this device>]   pair with a machine (the link cq pair shows)
  machines                             the machines this device is paired with
  status <machine>                     queue, running task, waiting requests, limits
  queue <machine> <folder> <prompt…>   [--model m] [--effort e] [--mode auto|edits|ask|bypass]
                                       [--no-plan] [--review] [--branch | --no-branch] [--front]
  answer <machine> <code> allow|deny   or: answer <machine> <code> <your answer…>
  control <machine> go|pause|stop|skip|continue|fork|takeover
  peek <machine> [lines]               the running task's screen
  say <machine> <text…>                type into the running task
  keys <machine> <key…>                press keys in it (Enter, Escape, 1, Down…)
  chats <machine>                      recent conversations
  devices <machine>                    devices paired with that machine
  command <machine> <text…>            any text command (help lists them)
  watch [machine]                      print what happens, as it happens (Ctrl-C to stop)
`

const MODES: Record<string, QueueOptions['mode']> = { auto: 'auto', edits: 'acceptEdits', ask: 'plan', bypass: 'bypassPermissions' }

interface Saved extends MachineRecord {
  role: string
  lastSeq: number
}

const args = process.argv.slice(2)
const take = (name: string): string | undefined => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const [, value] = args.splice(i, 2)
  return value
}
const has = (name: string): boolean => {
  const i = args.indexOf(name)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}

// Flags first, so what's left is the command and its words.
const flags = {
  state: take('--state'),
  name: take('--name'),
  model: take('--model'),
  effort: take('--effort'),
  mode: take('--mode'),
  noPlan: has('--no-plan'),
  review: has('--review'),
  branch: has('--branch'),
  noBranch: has('--no-branch'),
  front: has('--front'),
}
const stateDir = resolve(flags.state ?? process.env.AFTERHOURS_CLIENT_HOME ?? join(homedir(), '.afterhours-client'))
const identityFile = join(stateDir, 'identity.json')
const machinesFile = join(stateDir, 'machines.json')

function identity(): Identity {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (existsSync(identityFile)) return decodeIdentity(readFileSync(identityFile, 'utf8'))
  const id = newIdentity()
  writeFileSync(identityFile, encodeIdentity(id) + '\n', { mode: 0o600 })
  chmodSync(identityFile, 0o600)
  return id
}

function machines(): Saved[] {
  return existsSync(machinesFile) ? (JSON.parse(readFileSync(machinesFile, 'utf8')) as Saved[]) : []
}

function saveMachines(list: Saved[]): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(machinesFile, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 })
}

function find(query: string | undefined): Saved {
  const list = machines()
  if (list.length === 0) fail('Not paired with any machine yet. Run: pair <link>')
  if (!query) {
    if (list.length === 1) return list[0]!
    fail(`Which machine? ${list.map(m => m.name).join(', ')}`)
  }
  const q = query!.toLowerCase()
  const hits = list.filter(m => m.name.toLowerCase() === q || m.id.toLowerCase().startsWith(q))
  if (hits.length !== 1) fail(hits.length ? `"${query}" matches several machines.` : `No machine called "${query}". Paired: ${list.map(m => m.name).join(', ')}`)
  return hits[0]!
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function client(): AppClient {
  return new AppClient({
    identity: identity(),
    device: { name: flags.name ?? `${hostname().replace(/\.local$/, '')} (command line)`, platform: `cli-${process.platform}`, app: 'afterhours-cli/0.1.0' },
  })
}

/** Connects and waits for the session; fails clearly when the machine refuses this device. */
async function open(app: AppClient, m: Saved): Promise<MachineConnection> {
  const conn = app.connect(m, { lastSeq: m.lastSeq })
  const end = Date.now() + 20_000
  while (conn.status !== 'connected') {
    if (conn.status === 'refused') fail(`${m.name} doesn't accept this device any more (it was removed). Pair again with cq pair.`)
    if (Date.now() > end) fail(`${m.name} isn't reachable: is Afterhours running there, and connected to ${m.relay}?`)
    await Bun.sleep(100)
  }
  return conn
}

function print(r: Result): void {
  if (!r.ok) fail(r.error ?? 'refused')
  if (r.text) console.log(r.text)
  else if (r.data !== undefined) console.log(JSON.stringify(r.data, null, 2))
}

function when(at: number | null | undefined): string {
  return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?'
}

function describe(s: Snapshot): string {
  const lines = [`${s.machine.name} (${s.machine.os} ${s.machine.arch}, Afterhours ${s.machine.version}) · you're ${s.role === 'operator' ? 'an' : 'a'} ${s.role}`]
  lines.push(s.active ? `Running #${s.active.id} [${s.active.phase ?? s.active.status}${s.active.holdReason ? `: ${s.active.holdReason}` : ''}] ${s.active.prompt.slice(0, 80)}` : 'Nothing running.')
  if (s.paused) lines.push('The queue is paused.')
  for (const j of s.queued) lines.push(`  next #${j.id}: ${j.prompt.slice(0, 80)}`)
  for (const a of s.approvals) lines.push(`  waiting for you: ${a.kind} ${a.code} (#${a.job})`)
  const five = s.limits.fiveHour
  if (five?.usedPct != null) lines.push(`5-hour limit: ${Math.round(five.usedPct)}% used, resets ${when(five.resetsAt)}`)
  if (s.limits.blockedUntil && s.limits.blockedUntil > Date.now()) lines.push(`Waiting for the limit reset at ${when(s.limits.blockedUntil)}`)
  return lines.join('\n')
}

async function main(): Promise<void> {
  const [cmd, ...rest] = args
  switch (cmd) {
    case 'pair': {
      const link = rest.join(' ')
      if (!link) fail('Usage: pair <link>')
      const app = client()
      console.log(`This device's key: ${fingerprint(peerId(identity().publicKey))}. Waiting for the machine to say yes…`)
      try {
        const paired = await app.pair(link)
        const list = machines().filter(m => m.id !== paired.machine.id)
        list.push({ id: paired.machine.id, name: paired.machine.name, relay: paired.machine.relay, role: paired.role, lastSeq: 0 })
        saveMachines(list)
        console.log(`✅ Paired with ${paired.machine.name} (${paired.machine.os}) as ${paired.role}.`)
      } finally {
        app.close()
      }
      return
    }
    case 'machines':
      for (const m of machines()) console.log(`${m.name} · ${m.role} · key ${fingerprint(m.id)} · ${m.relay}`)
      return
    case 'watch': {
      const app = client()
      const list = rest[0] ? [find(rest[0])] : machines()
      for (const m of list) {
        const conn = app.connect(m, { lastSeq: m.lastSeq })
        conn.on('status', status => console.log(`[${m.name}] ${status}`))
        conn.on('event', e => {
          console.log(`[${m.name}] ${e.text}`)
          saveMachines(machines().map(x => (x.id === m.id ? { ...x, lastSeq: e.seq } : x)))
        })
      }
      await new Promise(() => {})
      return
    }
  }

  const m = find(rest[0])
  const app = client()
  const conn = await open(app, m)
  try {
    switch (cmd) {
      case 'status': {
        const r = await conn.request({ type: 'snapshot' })
        if (!r.ok) fail(r.error ?? 'refused')
        console.log(describe(r.data as Snapshot))
        break
      }
      case 'queue': {
        const [, folder, ...prompt] = rest
        if (!folder || prompt.length === 0) fail('Usage: queue <machine> <folder> <prompt…>')
        const options: QueueOptions = {
          model: flags.model,
          effort: flags.effort as QueueOptions['effort'],
          mode: flags.mode ? (MODES[flags.mode] ?? fail(`--mode is one of ${Object.keys(MODES).join(', ')}`)) : undefined,
          plan: flags.noPlan ? false : undefined,
          review: flags.review || undefined,
          isolate: flags.branch ? true : flags.noBranch ? false : undefined,
          front: flags.front || undefined,
        }
        // A leading ~ is the machine's home folder: it's expanded there.
        print(await conn.request({ type: 'queue', folder, prompt: prompt.join(' '), options }))
        break
      }
      case 'answer': {
        const [, code, ...answer] = rest
        const word = answer.join(' ')
        if (!code || !word) fail('Usage: answer <machine> <code> allow|deny|<answer>')
        const decision = /^(allow|yes|y)$/i.test(word) ? 'allow' : /^(deny|no|n)$/i.test(word) ? 'deny' : 'answer'
        print(await conn.request({ type: 'answer', code, decision, text: decision === 'answer' ? word : null }))
        break
      }
      case 'control': {
        const action = rest[1] as 'go' | 'pause' | 'stop' | 'skip' | 'continue' | 'fork' | 'takeover'
        if (!['go', 'pause', 'stop', 'skip', 'continue', 'fork', 'takeover'].includes(action)) fail('Usage: control <machine> go|pause|stop|skip|continue|fork|takeover')
        print(await conn.request({ type: 'control', action }))
        break
      }
      case 'peek': {
        const r = await conn.request({ type: 'peek', lines: Number(rest[1] ?? 40) || 40 })
        if (!r.ok) fail(r.error ?? 'refused')
        const screen = r.data as { job: number; text: string } | null
        console.log(screen ? `#${screen.job}:\n${screen.text}` : (r.text ?? 'Nothing is running.'))
        break
      }
      case 'say':
        print(await conn.request({ type: 'say', text: rest.slice(1).join(' ') }))
        break
      case 'keys':
        print(await conn.request({ type: 'keys', keys: rest.slice(1) }))
        break
      case 'chats': {
        const r = await conn.request({ type: 'chats' })
        if (!r.ok) fail(r.error ?? 'refused')
        for (const c of (r.data as { chats: { session: string; title: string; folder: string | null; where: string | null }[] }).chats) {
          console.log(`@${c.session.slice(0, 8)} ${c.title.slice(0, 60)} · ${c.folder ?? '?'}${c.where ? ` · open in ${c.where}` : ''}`)
        }
        break
      }
      case 'devices': {
        const r = await conn.request({ type: 'devices' })
        if (!r.ok) fail(r.error ?? 'refused')
        for (const d of r.data as { id: string; name: string; platform: string; role: string }[]) console.log(`${d.name} · ${d.platform} · ${d.role} · key ${fingerprint(d.id)}`)
        break
      }
      case 'command':
        print(await conn.request({ type: 'command', text: rest.slice(1).join(' ') }))
        break
      default:
        console.log(USAGE)
    }
  } finally {
    saveMachines(machines().map(x => (x.id === m.id ? { ...x, lastSeq: conn.lastSeq } : x)))
    app.close()
  }
}

if (!args[0] || args[0] === 'help' || args[0] === '--help') console.log(USAGE)
else await main()
