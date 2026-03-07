import type { LoadMode, SessionRecord, SessionSource, SessionStreamEvent } from "../types"
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

function sessionDedupeKey(session: SessionRecord): string {
  return session.sessionId
    ? `${session.source}:${session.sessionId}`
    : `${session.source}:${session.filePath ?? session.uid}`
}

function mergeSession(previous: SessionRecord | undefined, next: SessionRecord): SessionRecord {
  if (!previous) {
    return next
  }

  const newer = next.updatedAt >= previous.updatedAt ? next : previous
  const older = newer === next ? previous : next

  return {
    ...older,
    ...newer,
    uid: sessionDedupeKey(newer),
    sessionId: newer.sessionId ?? older.sessionId,
    title: newer.title || older.title,
    summary: newer.summary ?? older.summary,
    filePath: newer.filePath ?? older.filePath,
    workspacePath: newer.workspacePath ?? older.workspacePath,
    updatedAt: Math.max(previous.updatedAt, next.updatedAt),
    startedAt: newer.startedAt ?? older.startedAt,
    resumeAction: newer.resumeAction ?? older.resumeAction,
    resumeHint: newer.resumeHint ?? older.resumeHint,
  }
}

function sortSessions(sessions: Iterable<SessionRecord>): SessionRecord[] {
  return Array.from(sessions).sort((a, b) => b.updatedAt - a.updatedAt)
}

async function* settleByCompletion<T>(tasks: Array<Promise<T>>): AsyncIterable<T> {
  interface PendingTask {
    promise: Promise<{ task: PendingTask; value: T | undefined }>
  }

  const pending: PendingTask[] = []

  for (const task of tasks) {
    const pendingTask = {} as PendingTask
    pendingTask.promise = task
      .then((value) => ({ task: pendingTask, value }))
      .catch(() => ({ task: pendingTask, value: undefined as T | undefined }))
    pending.push(pendingTask)
  }

  while (pending.length > 0) {
    const settled = await Promise.race(pending.map((task) => task.promise))
    const settledIndex = pending.indexOf(settled.task)
    if (settledIndex >= 0) {
      pending.splice(settledIndex, 1)
    }

    if (settled.value !== undefined) {
      yield settled.value
    }
  }
}

async function loadSourceSessions(source: SessionSource, mode: LoadMode): Promise<SessionRecord[]> {
  try {
    return (await source.listSessions(mode)).map((session) => ({
      ...session,
      uid: sessionDedupeKey(session),
    }))
  } catch {
    return []
  }
}

/** Loads sessions from all configured sources and returns them newest-first. */
export async function loadSessions(mode: LoadMode = "full"): Promise<SessionRecord[]> {
  const settled = await Promise.allSettled(allSources.map((source) => loadSourceSessions(source, mode)))

  const deduped = new Map<string, SessionRecord>()
  for (const result of settled) {
    if (result.status !== "fulfilled") {
      continue
    }

    for (const session of result.value) {
      const key = sessionDedupeKey(session)
      deduped.set(key, mergeSession(deduped.get(key), session))
    }
  }

  return sortSessions(deduped.values())
}

/** Streams fast source batches first, then follows with full hydration. */
export async function* loadSessionsIncremental(): AsyncIterable<SessionStreamEvent> {
  const aggregated = new Map<string, SessionRecord>()

  for (const source of allSources) {
    yield {
      type: "source-start",
      source: source.id,
      mode: "fast",
    }
  }

  const fastTasks = allSources.map(async (source) => ({
    source,
    sessions: await loadSourceSessions(source, "fast"),
  }))

  for await (const result of settleByCompletion(fastTasks)) {
    for (const session of result.sessions) {
      const key = sessionDedupeKey(session)
      aggregated.set(key, mergeSession(aggregated.get(key), session))
    }

    yield {
      type: "batch",
      source: result.source.id,
      mode: "fast",
      sessions: sortSessions(result.sessions),
    }
  }

  const fullTasks = allSources.map(async (source) => ({
    source,
    sessions: await loadSourceSessions(source, "full"),
  }))

  for await (const result of settleByCompletion(fullTasks)) {
    const changed: SessionRecord[] = []

    for (const session of result.sessions) {
      const key = sessionDedupeKey(session)
      const merged = mergeSession(aggregated.get(key), session)
      aggregated.set(key, merged)
      changed.push(merged)
    }

    yield {
      type: "batch",
      source: result.source.id,
      mode: "full",
      sessions: sortSessions(changed),
    }

    yield {
      type: "source-complete",
      source: result.source.id,
      mode: "full",
    }
  }

  yield {
    type: "complete",
    mode: "full",
    sessions: sortSessions(aggregated.values()),
  }
}
