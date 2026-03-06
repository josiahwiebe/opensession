import type { SessionRecord, SessionSource } from "../types"
import { fileStat, readTextSample, scanFilesByPatterns } from "../utils/fs"
import { prettySource, truncate } from "../utils/format"
import { parseJsonSafe } from "./shared"

/** De-duplicates path candidates while preserving order. */
function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths))
}

const FALLBACK_ROOTS = uniquePaths([
  "~/.local/share/opencode",
  "~/.local/share/OpenCode",
  "~/Library/Application Support/opencode",
  "~/Library/Application Support/OpenCode",
  "~/.config/opencode",
  "~/.config/OpenCode",
  "~/.opencode",
])

const FALLBACK_PATTERNS = [
  "storage/session/**/ses_*.json",
  "project/**/storage/session/info/ses_*.json",
  "project/**/storage/session/share/ses_*.json",
]

interface ParsedOpenCodeSessionMeta {
  id: string
  title?: string
  directory?: string
  created?: number
  updated?: number
  parentSessionId?: string
}

interface OpenCodeSessionRecord extends SessionRecord {
  parentSessionId?: string
}

function normalizeDate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000
  }

  if (typeof value === "string" && value.length > 0) {
    const date = Date.parse(value)
    return Number.isNaN(date) ? undefined : date
  }

  return undefined
}

function parseParentSessionId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined
  }

  const value = item as Record<string, unknown>
  return typeof value.parentID === "string" ? value.parentID : undefined
}

function runOpenCodeSessionList(): OpenCodeSessionRecord[] {
  const proc = Bun.spawnSync({
    cmd: ["opencode", "session", "list", "--format", "json"],
    stderr: "pipe",
    stdout: "pipe",
  })

  if (proc.exitCode !== 0) {
    return []
  }

  const raw = proc.stdout.toString().trim()
  if (!raw) {
    return []
  }

  const data = parseJsonSafe(raw)
  const items = Array.isArray(data)
    ? data
    : typeof data === "object" && data && "sessions" in data && Array.isArray((data as any).sessions)
      ? (data as any).sessions
      : []

  return items
    .map((item: any): OpenCodeSessionRecord | null => {
      const sessionId =
        item?.id ?? item?.sessionID ?? item?.sessionId ?? item?.uuid ?? item?.name ?? undefined
      if (!sessionId || typeof sessionId !== "string") {
        return null
      }

      const title =
        (typeof item?.title === "string" && item.title) ||
        (typeof item?.name === "string" && item.name) ||
        `Session ${sessionId.slice(0, 8)}`

      const updatedAt =
        normalizeDate(item?.updatedAt) ??
        normalizeDate(item?.updated) ??
        normalizeDate(item?.updated_at) ??
        normalizeDate(item?.createdAt) ??
        normalizeDate(item?.created) ??
        Date.now()

      const startedAt =
        normalizeDate(item?.createdAt) ??
        normalizeDate(item?.created) ??
        normalizeDate(item?.created_at) ??
        updatedAt

      return {
        uid: `opencode:${sessionId}`,
        source: "opencode",
        sourceLabel: "OpenCode",
        sessionId,
        parentSessionId: parseParentSessionId(item),
        title: truncate(title, 90),
        summary: typeof item?.summary === "string" ? truncate(item.summary, 180) : undefined,
        updatedAt,
        startedAt,
        workspacePath:
          (typeof item?.directory === "string" && item.directory) ||
          (typeof item?.path === "string" && item.path) ||
          undefined,
        resumeAction: {
          command: "opencode",
          args: ["--session", sessionId],
        },
        resumeHint: "Runs `opencode --session <id>`",
      }
    })
    .filter((value: OpenCodeSessionRecord | null): value is OpenCodeSessionRecord => Boolean(value))
}

function parseOpenCodeSessionMeta(raw: string): ParsedOpenCodeSessionMeta | undefined {
  const parsed = parseJsonSafe(raw)
  if (!parsed || typeof parsed !== "object") {
    return undefined
  }

  const value = parsed as Record<string, unknown>
  const id = typeof value.id === "string" ? value.id : undefined
  if (!id || !id.startsWith("ses_")) {
    return undefined
  }

  const time = value.time && typeof value.time === "object" ? (value.time as Record<string, unknown>) : undefined
  const created = typeof time?.created === "number" ? time.created : undefined
  const updated = typeof time?.updated === "number" ? time.updated : undefined

  return {
    id,
    title: typeof value.title === "string" ? value.title : undefined,
    directory: typeof value.directory === "string" ? value.directory : undefined,
    created,
    updated,
    parentSessionId: typeof value.parentID === "string" ? value.parentID : undefined,
  }
}

async function listFallback(): Promise<OpenCodeSessionRecord[]> {
  const files = await scanFilesByPatterns({
    roots: FALLBACK_ROOTS,
    patterns: FALLBACK_PATTERNS,
    maxFiles: 5000,
  })

  const sessions = await Promise.all(
    files.map(async (filePath): Promise<OpenCodeSessionRecord | null> => {
      const stat = await fileStat(filePath)
      if (!stat) {
        return null
      }

      const rawContent = await readTextSample(filePath, 8192)
      const parsed = parseOpenCodeSessionMeta(rawContent)
      if (!parsed) {
        return null
      }

      const sessionId = parsed.id
      const title =
        (parsed.title && parsed.title.trim().length > 0 ? parsed.title.trim() : undefined) ??
        `Session ${sessionId.slice(0, 14)}`

      return {
        uid: `opencode:${sessionId}`,
        source: "opencode",
        sourceLabel: prettySource("opencode"),
        sessionId,
        parentSessionId: parsed.parentSessionId,
        title: truncate(title, 90),
        summary: parsed.directory ? truncate(parsed.directory, 180) : undefined,
        workspacePath: parsed.directory,
        updatedAt: parsed.updated ?? stat.mtimeMs,
        startedAt: parsed.created ?? stat.birthtimeMs,
        resumeAction: {
          command: "opencode",
          args: ["--session", sessionId],
        },
        resumeHint: "Runs `opencode --session <id>`",
      }
    }),
  )

  return sessions.filter((session): session is OpenCodeSessionRecord => Boolean(session))
}

function dedupeOpencodeSessions(sessions: OpenCodeSessionRecord[]): OpenCodeSessionRecord[] {
  const bySessionId = new Map<string, OpenCodeSessionRecord>()

  for (const session of sessions) {
    if (!session.sessionId) {
      continue
    }

    const key = session.sessionId
    const existing = bySessionId.get(key)
    if (!existing) {
      bySessionId.set(key, session)
      continue
    }

    const latest = session.updatedAt >= existing.updatedAt ? session : existing
    const older = latest === session ? existing : session
    bySessionId.set(key, {
      ...older,
      ...latest,
      parentSessionId: latest.parentSessionId ?? older.parentSessionId,
      workspacePath: latest.workspacePath ?? older.workspacePath,
      summary: latest.summary ?? older.summary,
      startedAt: latest.startedAt ?? older.startedAt,
      resumeAction: latest.resumeAction ?? older.resumeAction,
      resumeHint: latest.resumeHint ?? older.resumeHint,
    })
  }

  return Array.from(bySessionId.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

function toPublicRecord(session: OpenCodeSessionRecord): SessionRecord {
  return {
    uid: session.uid,
    source: session.source,
    sourceLabel: session.sourceLabel,
    sessionId: session.sessionId,
    title: session.title,
    summary: session.summary,
    filePath: session.filePath,
    workspacePath: session.workspacePath,
    updatedAt: session.updatedAt,
    startedAt: session.startedAt,
    resumeAction: session.resumeAction,
    resumeHint: session.resumeHint,
  }
}

function collapseSubagentSessions(sessions: OpenCodeSessionRecord[]): SessionRecord[] {
  const bySessionId = new Map<string, OpenCodeSessionRecord>()
  for (const session of sessions) {
    if (session.sessionId) {
      bySessionId.set(session.sessionId, session)
    }
  }

  const childCountByParent = new Map<string, number>()
  for (const session of sessions) {
    const parentId = session.parentSessionId
    if (!parentId || !bySessionId.has(parentId)) {
      continue
    }

    childCountByParent.set(parentId, (childCountByParent.get(parentId) ?? 0) + 1)
  }

  return sessions
    .filter((session) => {
      const parentId = session.parentSessionId
      return !(parentId && bySessionId.has(parentId))
    })
    .map((session) => {
      const childCount = session.sessionId ? (childCountByParent.get(session.sessionId) ?? 0) : 0
      if (childCount === 0) {
        return toPublicRecord(session)
      }

      const childLabel = `${childCount} subagent ${childCount === 1 ? "session" : "sessions"}`
      return {
        ...toPublicRecord(session),
        summary: truncate(
          session.summary ? `${session.summary} - ${childLabel}` : childLabel,
          180,
        ),
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export const opencodeSource: SessionSource = {
  id: "opencode",
  label: "OpenCode",
  async listSessions(): Promise<SessionRecord[]> {
    const fromCli = runOpenCodeSessionList()
    const fromFiles = await listFallback()
    const deduped = dedupeOpencodeSessions([...fromCli, ...fromFiles])
    return collapseSubagentSessions(deduped)
  },
}
