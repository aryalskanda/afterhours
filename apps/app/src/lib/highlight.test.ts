import { describe, expect, test } from 'bun:test'
import { highlight, type Token } from './highlight'

const kinds = (tokens: Token[]) => tokens.filter(t => t.kind !== 'plain').map(t => `${t.kind}:${t.text}`)

describe('code colours', () => {
  test('TypeScript: keywords, strings, template literals, comments, numbers', () => {
    const code = "export const theme = 'dark' // the default\nconst n = 0x1F + 2.5e3\n/* note */ const s = `a ${n}`"
    expect(kinds(highlight(code, 'ts'))).toEqual(['keyword:export', 'keyword:const', "string:'dark'", 'comment:// the default', 'keyword:const', 'number:0x1F', 'number:2.5e3', 'comment:/* note */', 'keyword:const', 'string:`a ${n}`'])
    // Everything is still there, in order.
    expect(highlight(code, 'tsx').map(t => t.text).join('')).toBe(code)
  })

  test('Python and shell comments; names with digits aren’t numbers', () => {
    expect(kinds(highlight('def f(x2):\n    return """doc""" # done', 'python'))).toEqual(['keyword:def', 'keyword:return', 'string:"""doc"""', 'comment:# done'])
    expect(kinds(highlight('echo $# items # count', 'bash'))).toEqual(['keyword:echo', 'comment:# count'])
    expect(kinds(highlight('SELECT id FROM jobs WHERE n > 2', 'sql'))).toEqual(['keyword:SELECT', 'keyword:FROM', 'keyword:WHERE', 'number:2'])
  })

  test('diffs by line; unknown languages plain; an unclosed string doesn’t run away', () => {
    expect(kinds(highlight('--- a/x\n+++ b/x\n-old\n+new\n same', 'diff'))).toEqual(['removed:-old', 'added:+new'])
    expect(highlight('whatever <b>', 'brainfuck')).toEqual([{ text: 'whatever <b>', kind: 'plain' }])
    expect(kinds(highlight("const a = 'oops\nconst b = 1", 'js'))).toEqual(['keyword:const', "string:'oops", 'keyword:const', 'number:1'])
  })
})
