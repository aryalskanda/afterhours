// The slice of the Telegram Bot API cq uses (https://core.telegram.org/bots/api), over fetch.

export interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

export interface TgChat {
  id: number
  type: string
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

export interface InlineButton {
  text: string
  callback_data: string
}

export type InlineKeyboard = InlineButton[][]

export interface ReplyKeyboard {
  keyboard: { text: string }[][]
  is_persistent?: boolean
  resize_keyboard?: boolean
}

export type Markup = { inline_keyboard: InlineKeyboard } | ReplyKeyboard

/** What the bridge needs from Telegram; tests swap in a fake. */
export interface BotApi {
  getMe(): Promise<TgUser>
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>
  sendMessage(chatId: number, html: string, markup?: Markup): Promise<TgMessage>
  /** Sends text as a file, for answers too long for messages. */
  sendDocument(chatId: number, filename: string, content: string, caption?: string): Promise<TgMessage>
  editMessageText(chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void>
  answerCallbackQuery(id: string, text?: string): Promise<void>
  setMyCommands(commands: { command: string; description: string }[]): Promise<void>
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    description: string,
  ) {
    super(`telegram ${method}: ${code} ${description}`)
  }
}

interface ApiResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

export class TelegramApi implements BotApi {
  constructor(private token: string) {}

  private async call<T>(method: string, body: object | FormData, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs)
      let res: Response
      try {
        res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST',
          ...(body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      } catch (err) {
        // Never let the token (it's in the URL) reach a log line.
        const message = (err instanceof Error ? err.message : String(err)).split(this.token).join('***')
        throw new TelegramError(method, 0, message)
      }
      const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as ApiResponse<T>
      if (json.ok) return json.result as T
      if (json.error_code === 429 && attempt < 3) {
        await Bun.sleep(((json.parameters?.retry_after ?? 1) + 0.5) * 1000)
        continue
      }
      throw new TelegramError(method, json.error_code ?? res.status, json.description ?? 'unknown error')
    }
  }

  getMe(): Promise<TgUser> {
    return this.call('getMe', {})
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
      (timeoutSec + 15) * 1000,
      signal,
    )
  }

  sendMessage(chatId: number, html: string, markup?: Markup): Promise<TgMessage> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(markup ? { reply_markup: markup } : {}),
    })
  }

  sendDocument(chatId: number, filename: string, content: string, caption?: string): Promise<TgMessage> {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('document', new Blob([content], { type: 'text/markdown' }), filename)
    if (caption) form.append('caption', caption)
    return this.call('sendDocument', form, 60_000)
  }

  async editMessageText(chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard ?? [] },
      })
    } catch (err) {
      // Tapping a button that leaves the screen as it was isn't an error.
      if (err instanceof TelegramError && /message is not modified/i.test(err.message)) return
      throw err
    }
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) })
  }

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call('setMyCommands', { commands })
  }
}
