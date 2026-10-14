import { describe, expect, test } from 'bun:test'
import { chunkText } from '../src/imessage/bridge'
import { parseAttributedBody } from '../src/imessage/chatdb'

/** A minimal typedstream NSAttributedString blob, as chat.db stores it. */
function blob(text: string): Uint8Array {
  const body = Buffer.from(text, 'utf8')
  let len: Buffer
  if (body.length < 0x80) len = Buffer.from([body.length])
  else if (body.length < 0x100) len = Buffer.from([0x81, body.length])
  else {
    len = Buffer.alloc(3)
    len[0] = 0x82
    len.writeUInt16LE(body.length, 1)
  }
  return Buffer.concat([
    Buffer.from('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08', 'latin1'),
    Buffer.from('NSString\x01\x94\x84\x01+', 'latin1'),
    len,
    body,
    Buffer.from('\x86\x84\x02iI\x01', 'latin1'),
  ])
}

describe('parseAttributedBody', () => {
  test('short text', () => {
    expect(parseAttributedBody(blob('q nacho plan: add dark mode'))).toBe('q nacho plan: add dark mode')
  })

  test('emoji and medium length (0x81 prefix)', () => {
    const text = '🤖 ' + 'x'.repeat(150)
    expect(parseAttributedBody(blob(text))).toBe(text)
  })

  test('long text (0x82 prefix)', () => {
    const text = 'y'.repeat(1000)
    expect(parseAttributedBody(blob(text))).toBe(text)
  })

  test('null and junk', () => {
    expect(parseAttributedBody(null)).toBeNull()
    expect(parseAttributedBody(Buffer.from('not a typedstream'))).toBeNull()
  })
})

describe('chunkText', () => {
  test('short text is one chunk', () => {
    expect(chunkText('hello', 10)).toEqual(['hello'])
  })

  test('splits on paragraph, then line, then word boundaries', () => {
    expect(chunkText('aaaa bbbb\n\ncccc dddd', 12)).toEqual(['aaaa bbbb', 'cccc dddd'])
    expect(chunkText('aaaa bbbb cccc', 10)).toEqual(['aaaa bbbb', 'cccc'])
  })

  test('every chunk fits', () => {
    const parts = chunkText('word '.repeat(1000), 100)
    expect(parts.every(p => p.length <= 100)).toBe(true)
    expect(parts.join(' ').replace(/\s+/g, ' ').trim()).toBe('word '.repeat(1000).trim())
  })
})
