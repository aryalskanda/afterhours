// Runs the relay. Settings come from the environment:
//   PORT (8787), HOST (0.0.0.0), RELAY_DB (relay.db; ':memory:' keeps nothing),
//   APP_DIR (unset; the app's web build, to serve it at the same address)
// Put it behind TLS (Caddy, a load balancer, Fly.io) and give apps and machines the wss:// address.

import { startRelay } from './server'

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)
const relay = startRelay({
  port: Number(process.env.PORT ?? 8787),
  hostname: process.env.HOST ?? '0.0.0.0',
  db: process.env.RELAY_DB ?? 'relay.db',
  appDir: process.env.APP_DIR || undefined,
  log,
})

const shutdown = () => {
  log('stopping')
  void relay.stop().then(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
