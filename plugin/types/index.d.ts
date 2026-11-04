export type AccountName = string

declare module 'claude-code' {
  interface PluginState {
    'multiclaude-move': {
      target: AccountName | null
      moved: AccountName | null
    }
  }
}
