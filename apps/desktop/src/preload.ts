// The page's only way to the rest of the desktop app: a few calls, each checked again on the other
// side. The page never sees Electron or Node.

import { contextBridge, ipcRenderer } from 'electron'

type Kind = 'link' | 'route'

interface Info {
  version: string
  platform: string
  deviceName: string
  keyProtected: boolean
  test: boolean
}

function readInfo(): Info | null {
  const arg = process.argv.find(a => a.startsWith('--afterhours='))
  if (!arg) return null
  try {
    const bytes = Uint8Array.from(atob(arg.slice('--afterhours='.length)), c => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as Info
  } catch {
    return null
  }
}

const info = readInfo()

/** Calls `cb` with what's waiting (a link that opened the app, a notification clicked), then live. */
function subscribe(kind: Kind, cb: (value: string) => void): () => void {
  const listener = (_event: unknown, o: { kind?: unknown; value?: unknown }) => {
    if (o?.kind === kind && typeof o.value === 'string') cb(o.value)
  }
  ipcRenderer.on('open', listener)
  void ipcRenderer.invoke('open:pending', kind).then((values: unknown) => {
    if (Array.isArray(values)) for (const v of values) if (typeof v === 'string') cb(v)
  })
  return () => {
    ipcRenderer.removeListener('open', listener)
  }
}

contextBridge.exposeInMainWorld('afterhoursDesktop', {
  info,
  secrets: {
    get: (key: string) => ipcRenderer.invoke('secrets:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),
  },
  notify: (n: { title: string; body: string; route: string }) => ipcRenderer.send('notify', n),
  setNeedsYou: (count: number) => ipcRenderer.send('needs-you', count),
  onLink: (cb: (link: string) => void) => subscribe('link', cb),
  onNavigate: (cb: (route: string) => void) => subscribe('route', cb),
  loginItem: {
    get: () => ipcRenderer.invoke('login-item:get'),
    set: (on: boolean) => ipcRenderer.invoke('login-item:set', on),
  },
  ...(info?.test
    ? {
        test: {
          state: () => ipcRenderer.invoke('test:state'),
          closeWindow: () => ipcRenderer.invoke('test:close-window'),
          clickNotification: (index: number) => ipcRenderer.invoke('test:click-notification', index),
        },
      }
    : {}),
})
