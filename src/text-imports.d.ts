// Files imported with `with { type: 'text' }` are embedded as strings (also in the compiled binary).
declare module '*.sh' {
  const text: string
  export default text
}

declare module '*.c' {
  const text: string
  export default text
}
