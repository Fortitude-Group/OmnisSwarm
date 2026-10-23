/** What a person calls an agent in a message: its name, else its task description, else its id. The lead is main. */
import type { EngineInterface } from 'claude-code'
import { cleanText } from './record-events.ts'

export async function agentLabel($: EngineInterface, id: string | null): Promise<string> {
  if (id === null) return 'main'
  try {
    const found = (await $.agent.list()).find(a => a.id === id)
    return cleanText(found?.name, 64) || cleanText(found?.description, 64) || cleanText(id, 64)
  } catch {
    return cleanText(id, 64)
  }
}
