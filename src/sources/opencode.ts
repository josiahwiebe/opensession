import path from "node:path"
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

function runOpenCodeSessionList(): SessionRecord[] {
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

  const parsed = items
    .map((item: any): SessionRecord | null => {
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
    .filter((value: SessionRecord | null): value is SessionRecord => Boolean(value))

  return parsed
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

function extractSessionIdFromPath(filePath: string): string | undefined {
  const fromPath = filePath.match(/\/(ses_[A-Za-z0-9]+)\//)
  if (fromPath?.[1]) {
    return fromPath[1]
  }

  const fromName = path.basename(filePath).match(/(ses_[A-Za-z0-9]+)/)
  return fromName?.[1]
}

interface ParsedOpenCodeSessionMeta {
  id: string
  title?: string
  directory?: string
  created?: number
  updated?: number
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
  }
}

function dedupeOpencodeSessions(sessions: SessionRecord[]): SessionRecord[] {
  const byUid = new Map<string, SessionRecord>()

  for (const session of sessions) {
    const pathSessionId = session.filePath ? extractSessionIdFromPath(session.filePath) : undefined
    const existingSessionId = session.sessionId
    const looksLikeMessageOrPartId =
      typeof existingSessionId === "string" &&
      (existingSessionId.startsWith("msg_") || existingSessionId.startsWith("prt_"))
    const inferredSessionId =
      pathSessionId ?? (looksLikeMessageOrPartId ? undefined : existingSessionId)
    const dedupeKey = inferredSessionId ? `opencode:${inferredSessionId}` : session.uid

    const normalized: SessionRecord = {
      ...session,
      sessionId: inferredSessionId ?? session.sessionId,
      uid: dedupeKey,
    }

    const existing = byUid.get(dedupeKey)
    if (!existing || normalized.updatedAt > existing.updatedAt) {
      byUid.set(dedupeKey, normalized)
    }
  }

  return Array.from(byUid.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

async function listFallback(): Promise<SessionRecord[]> {
  const files = await scanFilesByPatterns({
    roots: FALLBACK_ROOTS,
    patterns: FALLBACK_PATTERNS,
    maxFiles: 5000,
  })

  const sessions = await Promise.all(
    files.map(async (filePath): Promise<SessionRecord | null> => {
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

  return sessions.filter((session): session is SessionRecord => Boolean(session))
}

export const opencodeSource: SessionSource = {
  id: "opencode",
  label: "OpenCode",
  async listSessions(): Promise<SessionRecord[]> {
    const fromCli = runOpenCodeSessionList()
    const fromFiles = await listFallback()

    const enriched = await Promise.all(
      fromFiles.map(async (session) => {
        if (!session.filePath) {
          return session
        }

        const stat = await fileStat(session.filePath)
        return {
          ...session,
          updatedAt: stat?.mtimeMs ?? session.updatedAt,
        }
      }),
    )

    return dedupeOpencodeSessions([...fromCli, ...enriched])
  },
}
