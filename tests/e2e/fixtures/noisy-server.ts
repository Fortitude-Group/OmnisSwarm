// Test fixture: the guard first, then a noisy module, then the real server.
import '../../../src/mcp/stdio-guard.ts'
import './noisy-module.ts'
import '../../../src/mcp/server.ts'
