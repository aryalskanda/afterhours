import { BRAND } from '../shared/brand'
import { loadConfig, saveConfig } from '../shared/config'
import { agentLoaded, daemonTelegram, restartAgent } from './util'

export const TOKEN_RE = /^\d+:[\w-]{20,}$/

/** Asks Telegram who the token belongs to. */
export async function botName(token: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(15_000) })
  const body = (await res.json()) as { ok: boolean; result?: { username?: string }; description?: string }
  if (!body.ok || !body.result) throw new Error(body.description ?? `HTTP ${res.status}`)
  return `@${body.result.username}`
}

/** `cq telegram [token|off]`: connects the bot, restarts, and waits for you to pair. */
export async function telegramCommand(args: string[]): Promise<boolean> {
  const config = loadConfig()
  const arg = args[0]
  if (arg === 'off') {
    config.telegram.enabled = false
    saveConfig(config)
    console.log('Telegram is off. Your bot token is kept; run cq telegram <token> to turn it back on.')
    return true
  }
  if (!arg) {
    const s = await daemonTelegram()
    if (!config.telegram.enabled || !s?.bot) console.log('Telegram is not set up. Create a bot with @BotFather in Telegram, then run: cq telegram <token>')
    else console.log(s.paired ? `${s.bot} is paired with ${s.owner}.` : `${s.bot} is waiting to pair: send /start ${s.pairCode} to it.`)
    return true
  }
  if (!TOKEN_RE.test(arg)) {
    console.error("That doesn't look like a bot token. @BotFather gives one like 123456789:AAH4…")
    return false
  }
  let bot: string
  try {
    bot = await botName(arg)
  } catch (err) {
    console.error(`Telegram didn't accept that token: ${err instanceof Error ? err.message : err}`)
    return false
  }
  const sameBot = config.telegram.token?.split(':')[0] === arg.split(':')[0]
  config.telegram = {
    enabled: true,
    token: arg,
    // A new token for the same bot (after /revoke) keeps you paired.
    ownerId: sameBot ? config.telegram.ownerId : null,
    ownerName: sameBot ? config.telegram.ownerName : null,
  }
  const turnedOffIMessage = config.imessage.enabled
  config.imessage.enabled = false
  saveConfig(config)
  console.log(`Connected to ${bot}.${turnedOffIMessage ? ' iMessage is now off (Telegram replaces it).' : ''}`)

  if (agentLoaded()) restartAgent()
  else console.log(`(${BRAND.name} isn't running in the background; if \`cq daemon\` is running, it picks this up in a few seconds.)`)

  let status = await daemonTelegram()
  for (let i = 0; i < 30 && !status?.bot; i++) {
    await Bun.sleep(1000)
    status = await daemonTelegram()
  }
  if (!status?.bot) {
    console.error(`${BRAND.name} didn't pick up the bot. Check cq doctor and cq logs.`)
    return false
  }
  if (status.paired) {
    console.log(`✅ Paired with ${status.owner}. Send the bot a prompt to try it.`)
    return true
  }
  console.log(`\nNow, on your phone: open Telegram, find ${status.bot}, and send:\n\n    /start ${status.pairCode}\n\nWaiting for you to pair (Ctrl-C to stop waiting)…`)
  for (let i = 0; i < 300; i++) {
    await Bun.sleep(2000)
    const s = await daemonTelegram()
    if (s?.paired) {
      console.log(`✅ Paired with ${s.owner}. Send the bot what Claude should do.`)
      return true
    }
  }
  console.log('Still not paired. Run cq telegram (no arguments) to see the code again.')
  return false
}
