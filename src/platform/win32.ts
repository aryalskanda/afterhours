// Windows' own APIs, through bun:ffi: pseudo consoles (ConPTY) for the terminal host, and the
// process list for killing a task's processes. Loaded only on Windows; kernel32 is always there,
// so nothing extra is installed.

import { dlopen, FFIType, ptr } from 'bun:ffi'

const { u32, u64, i32, ptr: p, bool } = FFIType

let lib: ReturnType<typeof open> | null = null

function open() {
  return dlopen('kernel32.dll', {
    CreatePipe: { args: [p, p, p, u32], returns: bool },
    CreatePseudoConsole: { args: [u32, u64, u64, u32, p], returns: i32 },
    ResizePseudoConsole: { args: [u64, u32], returns: i32 },
    ClosePseudoConsole: { args: [u64], returns: FFIType.void },
    InitializeProcThreadAttributeList: { args: [p, u32, u32, p], returns: bool },
    UpdateProcThreadAttribute: { args: [p, u32, u64, u64, u64, p, p], returns: bool },
    DeleteProcThreadAttributeList: { args: [p], returns: FFIType.void },
    CreateProcessW: { args: [p, p, p, p, bool, u32, p, p, p, p], returns: bool },
    PeekNamedPipe: { args: [u64, p, u32, p, p, p], returns: bool },
    ReadFile: { args: [u64, p, u32, p, p], returns: bool },
    WriteFile: { args: [u64, p, u32, p, p], returns: bool },
    GetExitCodeProcess: { args: [u64, p], returns: bool },
    TerminateProcess: { args: [u64, u32], returns: bool },
    CloseHandle: { args: [u64], returns: bool },
    GetLastError: { args: [], returns: u32 },
    CreateToolhelp32Snapshot: { args: [u32, u32], returns: u64 },
    Process32FirstW: { args: [u64, p], returns: bool },
    Process32NextW: { args: [u64, p], returns: bool },
  })
}

function k32() {
  lib ??= open()
  return lib.symbols
}

const STILL_ACTIVE = 259
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
const CREATE_UNICODE_ENVIRONMENT = 0x00000400
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016n
const STARTF_USESTDHANDLES = 0x100
const TH32CS_SNAPPROCESS = 0x2
const INVALID_HANDLE = 0xffffffffffffffffn

function wide(s: string): Buffer {
  return Buffer.from(s + '\0', 'utf16le')
}

function lastError(what: string): Error {
  return new Error(`${what} failed (Windows error ${k32().GetLastError()})`)
}

/** Quotes one argument the way CreateProcess's command-line parser (and the C runtime) reads it back. */
export function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    if (ch === '"') out += '\\'.repeat(slashes * 2 + 1) + '"'
    else out += '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

/** A `NAME=value\0…\0\0` block, sorted as Windows expects. */
function envBlock(env: Record<string, string>): Buffer {
  const entries = Object.entries(env).sort(([a], [b]) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0))
  return Buffer.from(entries.map(([k, v]) => `${k}=${v}\0`).join('') + '\0', 'utf16le')
}

/** A process running in its own pseudo console: what it prints comes out of `read()`, keys go in with `write()`. */
export class PseudoConsole {
  readonly pid: number
  private hpc: bigint
  private process: bigint
  private input: bigint
  private output: bigint
  private closed = false
  private exit: number | null = null
  private readonly buf = new Uint8Array(65536)
  private readonly num = new Uint32Array(1)

  constructor(o: { argv: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }) {
    const k = k32()
    // Two pipes: we write keys into one, the console writes the screen into the other.
    const inRead = new BigUint64Array(1)
    const inWrite = new BigUint64Array(1)
    const outRead = new BigUint64Array(1)
    const outWrite = new BigUint64Array(1)
    if (!k.CreatePipe(inRead, inWrite, null, 0)) throw lastError('CreatePipe')
    if (!k.CreatePipe(outRead, outWrite, null, 0)) throw lastError('CreatePipe')
    const hpc = new BigUint64Array(1)
    const hr = k.CreatePseudoConsole(((o.rows & 0xffff) << 16) | (o.cols & 0xffff), inRead[0]!, outWrite[0]!, 0, hpc)
    if (hr !== 0) throw new Error(`CreatePseudoConsole failed (HRESULT 0x${(hr >>> 0).toString(16)})`)
    // The console holds its own ends now.
    k.CloseHandle(inRead[0]!)
    k.CloseHandle(outWrite[0]!)
    this.hpc = hpc[0]!
    this.input = inWrite[0]!
    this.output = outRead[0]!

    const size = new BigUint64Array(1)
    k.InitializeProcThreadAttributeList(null, 1, 0, size)
    const attrs = new Uint8Array(Number(size[0]))
    if (!k.InitializeProcThreadAttributeList(attrs, 1, 0, size)) throw lastError('InitializeProcThreadAttributeList')
    try {
      if (!k.UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, this.hpc, 8n, null, null)) throw lastError('UpdateProcThreadAttribute')
      // STARTUPINFOEXW: STARTUPINFOW (104 bytes on x64) and the attribute list after it. The
      // standard handles are set, to invalid ones: otherwise a program can end up writing to this
      // process's own (redirected) output instead of its console.
      const startup = new Uint8Array(112)
      const view = new DataView(startup.buffer)
      view.setUint32(0, 112, true)
      view.setUint32(60, STARTF_USESTDHANDLES, true)
      for (const offset of [80, 88, 96]) view.setBigUint64(offset, INVALID_HANDLE, true)
      view.setBigUint64(104, BigInt(ptr(attrs)), true)
      const info = new Uint8Array(24)
      const commandLine = wide(o.argv.map(quoteArg).join(' '))
      const ok = k.CreateProcessW(
        null,
        commandLine,
        null,
        null,
        false,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
        envBlock(o.env),
        wide(o.cwd),
        startup,
        info,
      )
      if (!ok) {
        const err = lastError(`starting ${o.argv[0]}`)
        this.dispose()
        throw err
      }
      const iv = new DataView(info.buffer)
      this.process = iv.getBigUint64(0, true)
      k.CloseHandle(iv.getBigUint64(8, true))
      this.pid = iv.getUint32(16, true)
    } finally {
      k.DeleteProcThreadAttributeList(attrs)
    }
  }

  /** What the console printed since the last call, without waiting; empty when there's nothing. */
  read(): Uint8Array {
    if (this.closed) return new Uint8Array(0)
    const k = k32()
    const chunks: Uint8Array[] = []
    for (;;) {
      this.num[0] = 0
      if (!k.PeekNamedPipe(this.output, null, 0, null, this.num, null) || this.num[0] === 0) break
      const want = Math.min(this.num[0]!, this.buf.length)
      this.num[0] = 0
      if (!k.ReadFile(this.output, this.buf, want, this.num, null) || this.num[0] === 0) break
      chunks.push(this.buf.slice(0, this.num[0]))
    }
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)
  }

  write(data: string | Uint8Array): void {
    if (this.closed) return
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    if (bytes.length === 0) return
    k32().WriteFile(this.input, bytes, bytes.length, this.num, null)
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) k32().ResizePseudoConsole(this.hpc, ((rows & 0xffff) << 16) | (cols & 0xffff))
  }

  /** The exit code once the process has ended; null while it runs. */
  exitCode(): number | null {
    if (this.exit !== null || this.closed) return this.exit
    const code = new Uint32Array(1)
    if (k32().GetExitCodeProcess(this.process, code) && code[0] !== STILL_ACTIVE) this.exit = code[0]!
    return this.exit
  }

  /** Ends the process (if it still runs) and the console. */
  dispose(): void {
    if (this.closed) return
    const k = k32()
    if (this.process && this.exitCode() === null) k.TerminateProcess(this.process, 1)
    // Drained first: on older Windows, closing a console whose output is still unread can wait on it.
    this.read()
    this.closed = true
    if (this.hpc) k.ClosePseudoConsole(this.hpc)
    for (const h of [this.input, this.output, this.process]) if (h) k.CloseHandle(h)
  }
}

const DETACHED_PROCESS = 0x00000008
const CREATE_NEW_PROCESS_GROUP = 0x00000200
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000

/**
 * Starts a program on its own: no console, outside this process's job where Windows allows it,
 * and inheriting none of this process's handles. Node's and Bun's spawn pass on every inheritable
 * handle, and a long-lived child holding the daemon's listening socket keeps its port taken after
 * the daemon ends. Returns the pid.
 */
export function spawnDetached(argv: string[], o: { cwd: string; env: Record<string, string> }): number {
  const k = k32()
  const startup = new Uint8Array(104)
  new DataView(startup.buffer).setUint32(0, 104, true)
  const flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT
  // A job that doesn't allow leaving it refuses CREATE_BREAKAWAY_FROM_JOB: then it stays in it.
  for (const extra of [CREATE_BREAKAWAY_FROM_JOB, 0]) {
    const info = new Uint8Array(24)
    if (k.CreateProcessW(null, wide(argv.map(quoteArg).join(' ')), null, null, false, flags | extra, envBlock(o.env), wide(o.cwd), startup, info)) {
      const iv = new DataView(info.buffer)
      k.CloseHandle(iv.getBigUint64(0, true))
      k.CloseHandle(iv.getBigUint64(8, true))
      return iv.getUint32(16, true)
    }
  }
  throw lastError(`starting ${argv[0]}`)
}

export interface ProcessEntry {
  pid: number
  ppid: number
  /** The program's file name, e.g. "cq.exe". */
  exe: string
}

/** Every process on the system (Toolhelp32). */
export function processList(): ProcessEntry[] {
  const k = k32()
  const list: ProcessEntry[] = []
  const snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (snap === INVALID_HANDLE || snap === 0n) return list
  try {
    // PROCESSENTRY32W on x64: dwSize at 0, th32ProcessID at 8, th32ParentProcessID at 32,
    // szExeFile (260 UTF-16 characters) at 44.
    const entry = new Uint8Array(568)
    const view = new DataView(entry.buffer)
    view.setUint32(0, 568, true)
    for (let ok = k.Process32FirstW(snap, entry); ok; ok = k.Process32NextW(snap, entry)) {
      const name = Buffer.from(entry.buffer, 44, 520).toString('utf16le')
      const end = name.indexOf('\0')
      list.push({ pid: view.getUint32(8, true), ppid: view.getUint32(32, true), exe: end < 0 ? name : name.slice(0, end) })
    }
  } finally {
    k.CloseHandle(snap)
  }
  return list
}

/** Every process's parent, by pid. */
export function processParents(): Map<number, number> {
  return new Map(processList().map(p => [p.pid, p.ppid]))
}

