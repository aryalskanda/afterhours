// The product's name and every identifier derived from it, in one place.

export const BRAND = {
  /** Shown to people. Never "Claude": Anthropic's terms forbid it in product names. */
  name: 'Afterhours',
  /** Folders, sockets, branch prefixes. */
  slug: 'afterhours',
  /** State folder under your home directory. */
  homeDir: '.afterhours',
  /** LaunchAgent label. */
  agentLabel: 'dev.afterhours.agent',
  /** GitHub "owner/repo" that publishes releases. */
  repo: 'aryalskanda/afterhours',
  /** Homebrew formula name. */
  formula: 'afterhours',
}

/** Where installs from before the rename keep their state; `cq install` moves it. */
export const LEGACY = {
  homeDir: '.claude-queue',
  agentLabel: 'com.skandaaryal.claude-queue',
  tmuxSocket: 'claude-queue',
}
