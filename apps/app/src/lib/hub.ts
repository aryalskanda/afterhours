// The app's one connection to the world: this device's key, the paired machines, a live
// encrypted session to each, and what they report. Screens read it (subscribe / getState) and ask
// it to act; it keeps what must survive a restart in the storage it's given.

import {
  AppClient,
  decodeIdentity,
  encodeIdentity,
  fingerprint,
  newIdentity,
  peerId,
  type Effort,
  type ExecMode,
  type Identity,
  type MachineConnection,
  type Paired,
  type Request,
  type Result,
  type SocketFactory,
  Snapshot,
} from '@afterhours/protocol'
import { applyActivity, applyEvent, applySnapshot, applyState, machineState, saved, wantsAttention, withStatus, type MachineState, type SavedMachine } from './state'

/** A request as screens write it (the hub adds the id). */
export type RequestBody = Request extends infer R ? (R extends { id: string } ? Omit<R, 'id'> : never) : never

/** Where the hub keeps things: secrets (the key) apart from the rest. */
export interface Storage {
  getSecret(key: string): Promise<string | null>
  setSecret(key: string, value: string): Promise<void>
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

export interface Prefs {
  /** Ask for Face ID / a fingerprint when the app opens. */
  lockApp: boolean
  /** Ask for it before allowing a permission request. */
  confirmAllow: boolean
  /** In a browser: system notifications while the tab is in the background. */
  browserNotifications: boolean
}

/** What a new task on a machine starts with: what you used last time there. */
export interface Choices {
  folder: string | null
  plan: boolean
  review: boolean
  mode: ExecMode
  model: string
  effort: Effort
  isolate: boolean
}

export interface Attention {
  id: number
  machine: string
  machineName: string
  text: string
  type: string
  /** The request it announces, so answering it (anywhere) takes the banner down. */
  code?: string
}

export interface HubState {
  ready: boolean
  error: string | null
  deviceId: string
  deviceName: string
  fingerprint: string
  machines: MachineState[]
  prefs: Prefs
  /** Prompts you saved, newest first. */
  saved: string[]
  outbox: Outgoing[]
  /** The latest live event that needs you, for a banner. */
  attention: Attention | null
}

export interface HubOptions {
  storage: Storage
  defaultName: string
  platform: string
  app: string
  socket?: SocketFactory
  log?: (line: string) => void
  now?: () => number
}

const KEYS = {
  identity: 'afterhours.identity',
  machines: 'afterhours.machines',
  name: 'afterhours.deviceName',
  prefs: 'afterhours.prefs',
  choices: 'afterhours.choices',
  saved: 'afterhours.savedPrompts',
  drafts: 'afterhours.drafts',
  outbox: 'afterhours.outbox',
}

/** A prompt you were writing, kept per machine until it's queued. */
export interface Draft {
  prompt: string
  folder: string | null
  at: number
}

/** A task to queue on a machine that was offline, sent when it's back. */
export interface Outgoing {
  id: string
  machine: string
  body: Extract<RequestBody, { type: 'queue' }>
  at: number
  /** Why the last try didn't go through. */
  error?: string
}

export class Hub {
  private client: AppClient | null = null
  private readonly conns = new Map<string, MachineConnection>()
  private readonly listeners = new Set<() => void>()
  private choices: Record<string, Choices> = {}
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private startedAt = 0
  private attentionSeq = 0
  private starting: Promise<void> | null = null
  private state: HubState = {
    ready: false,
    error: null,
    deviceId: '',
    deviceName: '',
    fingerprint: '',
    machines: [],
    prefs: { lockApp: false, confirmAllow: false, browserNotifications: false },
    attention: null,
    saved: [],
    outbox: [],
  }
  private drafts: Record<string, Draft> = {}

  constructor(private readonly o: HubOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): HubState => this.state

  private set(patch: Partial<HubState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  private updateMachine(id: string, change: (m: MachineState) => MachineState): void {
    const machines = this.state.machines.map(m => (m.id === id ? change(m) : m))
    this.set({ machines })
  }

  /** Loads the key and the machines, and connects; safe to call more than once. */
  init(): Promise<void> {
    this.starting ??= this.start()
    return this.starting
  }

  private async start(): Promise<void> {
    try {
      const s = this.o.storage
      let identity: Identity
      const stored = await s.getSecret(KEYS.identity)
      if (stored) {
        identity = decodeIdentity(stored)
      } else {
        identity = newIdentity()
        await s.setSecret(KEYS.identity, encodeIdentity(identity))
      }
      const name = (await s.get(KEYS.name)) || this.o.defaultName
      const machines = JSON.parse((await s.get(KEYS.machines)) ?? '[]') as SavedMachine[]
      const prefs = { ...this.state.prefs, ...(JSON.parse((await s.get(KEYS.prefs)) ?? '{}') as Partial<Prefs>) }
      this.choices = JSON.parse((await s.get(KEYS.choices)) ?? '{}') as Record<string, Choices>
      this.drafts = JSON.parse((await s.get(KEYS.drafts)) ?? '{}') as Record<string, Draft>
      const saved = JSON.parse((await s.get(KEYS.saved)) ?? '[]') as string[]
      const outbox = JSON.parse((await s.get(KEYS.outbox)) ?? '[]') as Outgoing[]
      const id = peerId(identity.publicKey)
      this.client = new AppClient({ identity, device: { name, platform: this.o.platform, app: this.o.app }, socket: this.o.socket, log: this.o.log })
      this.startedAt = this.now()
      this.set({ ready: true, deviceId: id, deviceName: name, fingerprint: fingerprint(id), machines: machines.map(machineState), prefs, saved, outbox })
      for (const m of machines) this.connect(m)
    } catch (err) {
      this.set({ ready: true, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private connect(m: SavedMachine): void {
    const conn = this.client!.connect({ id: m.id, name: m.name, relay: m.relay }, { lastSeq: m.lastSeq })
    this.conns.set(m.id, conn)
    conn.on('status', (status, detail) => {
      this.updateMachine(m.id, x => withStatus(x, status, detail))
      if (status === 'connected') void this.flush(m.id)
    })
    conn.on('snapshot', snapshot => {
      this.updateMachine(m.id, x => applySnapshot(x, snapshot))
      this.saveSoon()
    })
    conn.on('state', s => this.updateMachine(m.id, x => applyState(x, s)))
    conn.on('activity', a => this.updateMachine(m.id, x => applyActivity(x, a)))
    conn.on('event', e => {
      this.updateMachine(m.id, x => applyEvent(x, e))
      this.saveSoon()
      // A request answered anywhere: its banner goes.
      const shown = this.state.attention
      if (e.notice.type === 'resolved' && shown?.machine === m.id && shown.code === e.notice.code) this.set({ attention: null })
      // Replayed history isn't news; only what happens while the app is open gets a banner.
      if (wantsAttention(e.notice) && e.at >= this.startedAt - 5_000 && this.now() - e.at < 120_000) {
        const machine = this.state.machines.find(x => x.id === m.id)
        const code = 'code' in e.notice && typeof e.notice.code === 'string' ? e.notice.code : undefined
        this.set({ attention: { id: ++this.attentionSeq, machine: m.id, machineName: machine?.name ?? m.name, text: e.text, type: e.notice.type, ...(code ? { code } : {}) } })
      }
    })
  }

  /** Pairs with the machine in a pairing link; resolves once the machine says yes. */
  async pair(link: string): Promise<Paired> {
    if (!this.client) throw new Error('Not ready yet.')
    const paired = await this.client.pair(link.trim())
    const existing = this.state.machines.find(m => m.id === paired.machine.id)
    if (existing) {
      this.client.disconnect(existing.id)
      this.conns.delete(existing.id)
    }
    const record: SavedMachine = { id: paired.machine.id, name: paired.machine.name, relay: paired.machine.relay, role: paired.role, lastSeq: 0, addedAt: this.now() }
    const others = this.state.machines.filter(m => m.id !== record.id)
    this.set({ machines: [...others, { ...machineState(record), info: paired.machine }] })
    await this.save()
    this.connect(record)
    return paired
  }

  /** Removes a machine from this device, and asks it to forget this device too. */
  async forget(id: string): Promise<void> {
    const conn = this.conns.get(id)
    if (conn && conn.status === 'connected') {
      await conn.request({ type: 'devices.remove', device: this.state.deviceId }, { timeoutMs: 4000 }).catch(() => undefined)
    }
    this.client?.disconnect(id)
    this.conns.delete(id)
    this.set({ machines: this.state.machines.filter(m => m.id !== id) })
    await this.save()
  }

  /** Sends a request to a machine. Never throws: a failure comes back as a result that says why. */
  async request(id: string, body: RequestBody, o: { timeoutMs?: number } = {}): Promise<Result> {
    const conn = this.conns.get(id)
    if (!conn) return { type: 'result', id: 'local', ok: false, error: 'That machine is no longer paired with this device.' }
    if (conn.status === 'refused') return { type: 'result', id: 'local', ok: false, error: 'That machine removed this device. Pair it again.' }
    try {
      return await conn.request(body, o)
    } catch (err) {
      return { type: 'result', id: 'local', ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** The app came back to the foreground: reconnect now rather than when a ping notices. */
  wake(): void {
    this.client?.wake()
  }

  /** Pull to refresh: a fresh snapshot from every machine that's online (and a reconnect for the rest). */
  async refresh(): Promise<void> {
    this.wake()
    await Promise.all(
      [...this.conns.entries()].map(async ([id, conn]) => {
        if (conn.status !== 'connected') return
        const r = await conn.request({ type: 'snapshot' }, { timeoutMs: 8000 }).catch(() => null)
        const s = r?.ok ? Snapshot.safeParse(r.data) : null
        if (s?.success) this.updateMachine(id, x => applySnapshot(x, s.data))
      }),
    )
  }

  /** Renames this device here and on every machine that's online (the others keep the old name). */
  async setDeviceName(name: string): Promise<void> {
    const clean = name.trim().slice(0, 80)
    if (!clean) return
    if (this.client) this.client.o.device.name = clean
    this.set({ deviceName: clean })
    await this.o.storage.set(KEYS.name, clean)
    await Promise.all(
      [...this.conns.values()]
        .filter(conn => conn.status === 'connected')
        .map(conn => conn.request({ type: 'devices.rename', device: this.state.deviceId, name: clean }, { timeoutMs: 8000 }).catch(() => undefined)),
    )
  }

  async setPrefs(patch: Partial<Prefs>): Promise<void> {
    const prefs = { ...this.state.prefs, ...patch }
    this.set({ prefs })
    await this.o.storage.set(KEYS.prefs, JSON.stringify(prefs))
  }

  /** The choices a new task on this machine starts with. */
  choicesFor(id: string): Choices {
    const m = this.state.machines.find(x => x.id === id)
    const d = m?.defaults
    const base: Choices = {
      folder: null,
      plan: d?.plan ?? true,
      review: d?.review ?? false,
      mode: d?.mode ?? 'auto',
      model: d?.model ?? 'sonnet',
      effort: d?.effort ?? 'high',
      isolate: d?.isolate ?? true,
    }
    return { ...base, ...this.choices[id] }
  }

  async rememberChoices(id: string, choices: Choices): Promise<void> {
    this.choices = { ...this.choices, [id]: choices }
    await this.o.storage.set(KEYS.choices, JSON.stringify(this.choices))
  }

  // --- prompts: saved, drafts, and tasks waiting for an offline machine ---------------------------

  async savePrompt(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean) return
    const saved = [clean, ...this.state.saved.filter(x => x !== clean)].slice(0, 50)
    this.set({ saved })
    await this.o.storage.set(KEYS.saved, JSON.stringify(saved))
  }

  async removeSaved(text: string): Promise<void> {
    const saved = this.state.saved.filter(x => x !== text)
    this.set({ saved })
    await this.o.storage.set(KEYS.saved, JSON.stringify(saved))
  }

  draftFor(machine: string): Draft | null {
    return this.drafts[machine] ?? null
  }

  /** Keeps what you're writing for a machine; null when it was queued. */
  async saveDraft(machine: string, draft: Draft | null): Promise<void> {
    const { [machine]: _old, ...rest } = this.drafts
    this.drafts = draft && draft.prompt.trim() ? { ...rest, [machine]: draft } : rest
    await this.o.storage.set(KEYS.drafts, JSON.stringify(this.drafts))
  }

  /** Queues a task on a machine that's offline as soon as it's back. */
  async queueLater(machine: string, body: Outgoing['body']): Promise<void> {
    const item: Outgoing = { id: `${this.now()}-${Math.random().toString(36).slice(2, 8)}`, machine, body, at: this.now() }
    await this.setOutbox([...this.state.outbox, item])
    if (this.conns.get(machine)?.status === 'connected') void this.flush(machine)
  }

  async cancelOutgoing(id: string): Promise<void> {
    await this.setOutbox(this.state.outbox.filter(x => x.id !== id))
  }

  private async setOutbox(outbox: Outgoing[]): Promise<void> {
    this.set({ outbox })
    await this.o.storage.set(KEYS.outbox, JSON.stringify(outbox))
  }

  private flushing = new Set<string>()

  /** Sends what waited for this machine, oldest first; what it refuses stays, with its reason. */
  private async flush(machine: string): Promise<void> {
    if (this.flushing.has(machine)) return
    this.flushing.add(machine)
    try {
      for (const item of this.state.outbox.filter(x => x.machine === machine && !x.error)) {
        const r = await this.request(machine, item.body, { timeoutMs: 20_000 })
        if (r.ok) await this.setOutbox(this.state.outbox.filter(x => x.id !== item.id))
        else if (r.code) await this.setOutbox(this.state.outbox.map(x => (x.id === item.id ? { ...x, error: r.error ?? 'It was refused.' } : x)))
        else break // offline again: the next connection tries
      }
    } finally {
      this.flushing.delete(machine)
    }
  }

  dismissAttention(id: number): void {
    if (this.state.attention?.id === id) this.set({ attention: null })
  }

  private saveSoon(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 1500)
  }

  private async save(): Promise<void> {
    await this.o.storage.set(KEYS.machines, JSON.stringify(this.state.machines.map(saved)))
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.client?.close()
  }
}
