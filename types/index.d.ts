declare module 'claude-code' {
  interface PluginState {
    'omnis-swarm': { seen: string[]; dropped: number; paneOpen: boolean; panePinned: string | null }
  }
}
