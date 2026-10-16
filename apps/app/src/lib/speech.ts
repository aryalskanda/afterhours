// Claude's Markdown as something to say out loud: code blocks summarized, marks and links dropped.

export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (a code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/^\s*\|.*\|\s*$/gm, line => line.replace(/\|/g, ' ').replace(/[-:]{3,}/g, ''))
    .replace(/→/g, ' to ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
