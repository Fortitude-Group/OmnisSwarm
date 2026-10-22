declare module 'claude-code' {
  interface PluginState {
    'omnis-swarm': { seen: string[]; dropped: number; panePinned: string | null; paneStyle: string | null }
  }
}
