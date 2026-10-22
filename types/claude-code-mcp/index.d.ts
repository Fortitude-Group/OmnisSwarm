// Vendored from the engine-written .claude-plugin/types/claude-code-mcp/index.d.ts,
// as a Claude Code 2.1.306 session laid it down beside this mod (2026-10-22).
// The core declarations in ../claude-code are 2.1.307. Refresh: see docs/superpowers/plans/2026-10-21-omnisswarm-phase2-recorder.md, Task 1 Step 6.
// Trimmed to this plugin's own entries: the other servers that session had connected are left out. The entries under
// mcp__omnis-swarm__ (the server's name when it comes from .mcp.json) are copies of the plugin-named ones.
// The inputs of the MCP tools the session had connected when this mod
// was last saved, from each server's tools/list inputSchema.
// Merges into the engine's ToolCallInput (types/ McpToolInputs) so
// `e.tool === "mcp__<server>__<tool>"` narrows to the tool's arguments.
// Written again at a save of the mod with a server connected.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    /** Internal to the OmnisSwarm pane. When the OmnisSwarm mod is loaded it refuses calls from the model. */
    "mcp__plugin_omnis-swarm_omnis-swarm__omnis_feed": {
      /** The offset from the last reply; 0 for the whole state. */
      since?: number
      /** The swarm the last reply was about. */
      swarm?: string
    }
    /** Read a value from the swarm's shared memory. */
    "mcp__plugin_omnis-swarm_omnis-swarm__omnis_memory_get": {
      key: string
    }
    /** List keys in the swarm's shared memory with who wrote them and when. */
    "mcp__plugin_omnis-swarm_omnis-swarm__omnis_memory_list": {
      /** Only keys starting with this. */
      prefix?: string
    }
    /** Store a value (up to 4096 bytes) under a key in the swarm's shared memory, so other agents can read it with omnis_memory_get. */
    "mcp__plugin_omnis-swarm_omnis-swarm__omnis_memory_put": {
      /** e.g. "design/auth". */
      key: string
      /** At most 4096 bytes. */
      value: string
      /** Your agent name, so the pane shows who wrote it. */
      agent?: string
    }
    /** Internal to the omnis-swarm plugin: the recorder mod appends one observed event to the swarm log. Calls from the model are refused. */
    "mcp__plugin_omnis-swarm_omnis-swarm__omnis_record": {
      sessionId: string
      ts: string
      type: "agent.started" | "agent.finished" | "agent.usage" | "agent.tool" | "message.sent" | "session.measure"
      agent?: string
      data: {}
      dropped?: number
    }
    /** End the running swarm. Its log stays on disk; the next agent or omnis_swarm_init starts a new one. */
    "mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_end": {
      /** How it went, in a few words. */
      outcome?: string
    }
    /** Start a named swarm with a topology, so the OmnisSwarm pane groups and lays out the agents you spawn. If agents are already running in an unnamed session swarm, this names that swarm instead of starting another. */
    "mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_init": {
      /** Human name, e.g. "auth refactor". */
      name: string
      /** hierarchical: a lead with workers. mesh: peers talk to each other. star: everything goes through one hub. */
      topology: "hierarchical" | "mesh" | "star"
      /** One line on what the swarm is for. */
      goal?: string
    }
    /** Summarise the running swarm: agents with status, tokens and approximate cost, task counts and memory keys. */
    "mcp__plugin_omnis-swarm_omnis-swarm__omnis_swarm_status": {}
    /** Add a task to the swarm task board, optionally assigned to an agent. Returns its id (t1, t2, ...). */
    "mcp__plugin_omnis-swarm_omnis-swarm__omnis_task_create": {
      title: string
      /** Agent name. */
      assignee?: string
      dependsOn?: string[]
    }
    /** Change a task's state (pending, active, done, failed), assignee or note. */
    "mcp__plugin_omnis-swarm_omnis-swarm__omnis_task_update": {
      id: string
      state: "pending" | "active" | "done" | "failed"
      assignee?: string
      note?: string
    }
    /** Internal to the OmnisSwarm pane. When the OmnisSwarm mod is loaded it refuses calls from the model. */
    "mcp__omnis-swarm__omnis_feed": {
      /** The offset from the last reply; 0 for the whole state. */
      since?: number
      /** The swarm the last reply was about. */
      swarm?: string
    }
    /** Read a value from the swarm's shared memory. */
    "mcp__omnis-swarm__omnis_memory_get": {
      key: string
    }
    /** List keys in the swarm's shared memory with who wrote them and when. */
    "mcp__omnis-swarm__omnis_memory_list": {
      /** Only keys starting with this. */
      prefix?: string
    }
    /** Store a value (up to 4096 bytes) under a key in the swarm's shared memory, so other agents can read it with omnis_memory_get. */
    "mcp__omnis-swarm__omnis_memory_put": {
      /** e.g. "design/auth". */
      key: string
      /** At most 4096 bytes. */
      value: string
      /** Your agent name, so the pane shows who wrote it. */
      agent?: string
    }
    /** Internal to the omnis-swarm plugin: the recorder mod appends one observed event to the swarm log. Calls from the model are refused. */
    "mcp__omnis-swarm__omnis_record": {
      sessionId: string
      ts: string
      type: "agent.started" | "agent.finished" | "agent.usage" | "agent.tool" | "message.sent" | "session.measure"
      agent?: string
      data: {}
      dropped?: number
    }
    /** End the running swarm. Its log stays on disk; the next agent or omnis_swarm_init starts a new one. */
    "mcp__omnis-swarm__omnis_swarm_end": {
      /** How it went, in a few words. */
      outcome?: string
    }
    /** Start a named swarm with a topology, so the OmnisSwarm pane groups and lays out the agents you spawn. If agents are already running in an unnamed session swarm, this names that swarm instead of starting another. */
    "mcp__omnis-swarm__omnis_swarm_init": {
      /** Human name, e.g. "auth refactor". */
      name: string
      /** hierarchical: a lead with workers. mesh: peers talk to each other. star: everything goes through one hub. */
      topology: "hierarchical" | "mesh" | "star"
      /** One line on what the swarm is for. */
      goal?: string
    }
    /** Summarise the running swarm: agents with status, tokens and approximate cost, task counts and memory keys. */
    "mcp__omnis-swarm__omnis_swarm_status": {}
    /** Add a task to the swarm task board, optionally assigned to an agent. Returns its id (t1, t2, ...). */
    "mcp__omnis-swarm__omnis_task_create": {
      title: string
      /** Agent name. */
      assignee?: string
      dependsOn?: string[]
    }
    /** Change a task's state (pending, active, done, failed), assignee or note. */
    "mcp__omnis-swarm__omnis_task_update": {
      id: string
      state: "pending" | "active" | "done" | "failed"
      assignee?: string
      note?: string
    }
  }
}
