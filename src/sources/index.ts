import type { SessionRecord, SessionSource } from "../types"
import { claudeSource } from "./claude"
import { codexSource } from "./codex"
import { cursorSource } from "./cursor"
import { geminiSource } from "./gemini"
import { opencodeSource } from "./opencode"

export const allSources: SessionSource[] = [
  claudeSource,
  codexSource,
  cursorSource,
  geminiSource,
  opencodeSource,
]

/** Loads sessions from all configured sources and returns them newest-first. */
export async function loadSessions(): Promise<SessionRecord[]> {
  const settled = await Promise.allSettled(allSources.map((source) => source.listSessions()))

  const loaded: SessionRecord[] = []
  for (const result of settled) {
    if (result.status === "fulfilled") {
      loaded.push(...result.value)
    }
  }

  const deduped = new Map<string, SessionRecord>()
  for (const session of loaded) {
    const dedupeKey = session.sessionId
      ? `${session.source}:${session.sessionId}`
      : `${session.source}:${session.filePath ?? session.uid}`

    const previous = deduped.get(dedupeKey)
    if (!previous || session.updatedAt > previous.updatedAt) {
      deduped.set(dedupeKey, session)
    }
  }

  return Array.from(deduped.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}
