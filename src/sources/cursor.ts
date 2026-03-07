import path from "node:path"
import { Database } from "bun:sqlite"
import * as v from "valibot"
import type { LoadMode, SessionRecord, SessionSource } from "../types"
import { withMtimeCache } from "../utils/cache"
import {
  fileStat,
  platform,
  readTextSample,
  readTextTailSample,
  scanFilesByPatterns,
} from "../utils/fs"
import { truncate } from "../utils/format"
import {
  buildOpenFileResumeAction,
  buildSessionRecord,
  normalizeTimestamp,
  parseJsonSafe,
  parseJsonWithSchema,
} from "./shared"

function cursorUserRoot(): string {
  return platform() === "darwin"
    ? "~/Library/Application Support/Cursor/User"
    : "~/.config/Cursor/User"
}

function cursorWorkspaceRoot(): string {
  return path.join(cursorUserRoot(), "workspaceStorage")
}

function cursorGlobalRoot(): string {
  return path.join(cursorUserRoot(), "globalStorage")
}

function cursorTranscriptRoot(): string {
  return "~/.cursor/projects"
}

const CURSOR_WORKSPACE_DB_PATTERNS = ["*/state.vscdb"]
const CURSOR_GLOBAL_DB_PATTERNS = ["state.vscdb"]
const CURSOR_TRANSCRIPT_PATTERNS = ["*/agent-transcripts/*.txt"]

const CursorComposerEntrySchema = v.object({
  composerId: v.string(),
  name: v.optional(v.string()),
  createdAt: v.optional(v.union([v.number(), v.string()])),
  lastUpdatedAt: v.optional(v.union([v.number(), v.string()])),
  unifiedMode: v.optional(v.string()),
})

const CursorComposerListSchema = v.object({
  allComposers: v.array(CursorComposerEntrySchema),
})

const CursorConversationHeaderSchema = v.object({
  bubbleId: v.string(),
  type: v.optional(v.number()),
  text: v.optional(v.string()),
  richText: v.optional(v.string()),
})

const CursorGlobalComposerSchema = v.object({
  composerId: v.optional(v.string()),
  name: v.optional(v.string()),
  createdAt: v.optional(v.union([v.number(), v.string()])),
  lastUpdatedAt: v.optional(v.union([v.number(), v.string()])),
  unifiedMode: v.optional(v.string()),
  conversation: v.optional(v.array(CursorConversationHeaderSchema)),
})

interface CursorComposerMeta {
  composerId: string
  name?: string
  createdAt?: number
  updatedAt?: number
  unifiedMode?: string
}

interface CursorGlobalComposerMeta extends CursorComposerMeta {
  preview?: string
}

function looksLikeCodeSnippet(value: string | undefined): boolean {
  if (!value) {
    return false
  }

  const normalized = value.trim()
  if (!normalized) {
    return false
  }

  if (normalized.startsWith("```") || normalized.includes("---@")) {
    return true
  }

  const codeSignals = /(\breturn\b|\bconst\b|\blet\b|\bfunction\b|\bimport\b|\bexport\b|=>|\{\s*$)/
  const punctuationSignals = /[{};]{2,}|\{[^}]*\}/
  return codeSignals.test(normalized) && punctuationSignals.test(normalized)
}

function cleanCursorText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized || looksLikeCodeSnippet(normalized)) {
    return undefined
  }

  return normalized
}

function normalizeMaybeFileUri(rawPath: string): string {
  if (!rawPath.startsWith("file://")) {
    return rawPath
  }

  try {
    return decodeURIComponent(new URL(rawPath).pathname)
  } catch {
    return rawPath
  }
}

function readWorkspacePathFromObject(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key, candidate] of entries) {
    const normalizedKey = key.toLowerCase()
    const keyLooksLikePath =
      normalizedKey.includes("workspace") ||
      normalizedKey.includes("project") ||
      normalizedKey.includes("folder") ||
      normalizedKey.includes("root") ||
      normalizedKey === "cwd" ||
      normalizedKey.endsWith("path")

    if (keyLooksLikePath && typeof candidate === "string" && candidate.length > 0) {
      return normalizeMaybeFileUri(candidate)
    }

    if (candidate && typeof candidate === "object") {
      const nested = readWorkspacePathFromObject(candidate)
      if (nested) {
        return nested
      }
    }
  }

  return undefined
}

function extractCursorBubbleText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const bubble = value as Record<string, unknown>
  if (typeof bubble.text === "string") {
    return cleanCursorText(bubble.text)
  }

  if (typeof bubble.markdown === "string") {
    return cleanCursorText(bubble.markdown)
  }

  if (typeof bubble.richText === "string") {
    const richText = bubble.richText.match(/"text":"([^\"]{8,240})"/)
    if (richText?.[1]) {
      return cleanCursorText(richText[1].replace(/\\n/g, " "))
    }
  }

  return undefined
}

/** Parses Cursor workspace composer metadata. */
export function readCursorComposerMeta(rawValue: string): CursorComposerMeta[] {
  const parsed = parseJsonWithSchema(CursorComposerListSchema, rawValue)
  if (!parsed) {
    return []
  }

  return parsed.allComposers.map((entry) => ({
    composerId: entry.composerId,
    name: entry.name?.trim() || undefined,
    createdAt: normalizeTimestamp(entry.createdAt),
    updatedAt: normalizeTimestamp(entry.lastUpdatedAt) ?? normalizeTimestamp(entry.createdAt),
    unifiedMode: entry.unifiedMode,
  }))
}

/** Parses Cursor global composer metadata and best-effort preview text. */
export function readCursorGlobalComposer(rawValue: string, composerIdFromKey?: string): CursorGlobalComposerMeta | undefined {
  const parsed = parseJsonWithSchema(CursorGlobalComposerSchema, rawValue)
  if (!parsed) {
    return undefined
  }

  const composerId = parsed.composerId ?? composerIdFromKey
  if (!composerId) {
    return undefined
  }

  let preview: string | undefined
  const conversation = parsed.conversation ?? []
  for (const entry of [...conversation].reverse()) {
    const text = extractCursorBubbleText(entry)
    if (text && entry.type === 2) {
      preview = text
      break
    }

    if (!preview && text) {
      preview = text
    }
  }

  return {
    composerId,
    name: parsed.name?.trim() || undefined,
    createdAt: normalizeTimestamp(parsed.createdAt),
    updatedAt: normalizeTimestamp(parsed.lastUpdatedAt) ?? normalizeTimestamp(parsed.createdAt),
    unifiedMode: parsed.unifiedMode,
    preview,
  }
}

/** Extracts a short preview from an agent transcript. */
export function extractCursorTranscriptPreview(rawText: string): string | undefined {
  const lines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of [...lines].reverse()) {
    const preview = cleanCursorText(line)
    if (preview && !preview.startsWith("```")) {
      return preview
    }
  }

  return undefined
}

async function readWorkspacePathFromWorkspaceJson(dbPath: string): Promise<string | undefined> {
  const workspaceJsonPath = path.join(path.dirname(dbPath), "workspace.json")
  const stat = await fileStat(workspaceJsonPath)
  if (!stat) {
    return undefined
  }

  return withMtimeCache(`cursor:workspace-json:${workspaceJsonPath}`, stat.mtimeMs, async () => {
    const raw = await readTextSample(workspaceJsonPath, 4096)
    if (!raw) {
      return undefined
    }

    const parsed = parseJsonSafe(raw)
    return readWorkspacePathFromObject(parsed)
  })
}

async function readCursorGlobalComposerMap(composerIds?: Set<string>): Promise<Map<string, CursorGlobalComposerMeta>> {
  const sqliteFiles = await scanFilesByPatterns({
    roots: [cursorGlobalRoot()],
    patterns: CURSOR_GLOBAL_DB_PATTERNS,
    maxFiles: 4,
  })

  const byComposerId = new Map<string, CursorGlobalComposerMeta>()

  for (const dbPath of sqliteFiles) {
    const stat = await fileStat(dbPath)
    if (!stat) {
      continue
    }

    try {
      const rows = await withMtimeCache(
        `cursor:global-db:${dbPath}:${Array.from(composerIds ?? []).sort().join(",")}`,
        stat.mtimeMs,
        () => {
          const db = new Database(dbPath, { readonly: true })
          const result = composerIds && composerIds.size > 0
            ? db
                .query(`SELECT key, value FROM cursorDiskKV WHERE key IN (${Array.from(composerIds).map(() => "?").join(", ")}) AND value IS NOT NULL`)
                .all(...Array.from(composerIds).map((id) => `composerData:${id}`)) as Array<{ key?: string; value?: string }>
            : db
                .query("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value IS NOT NULL")
                .all() as Array<{ key?: string; value?: string }>
          db.close()
          return result
        },
      )

      for (const row of rows) {
        if (typeof row.value !== "string") {
          continue
        }

        const keyComposerId = typeof row.key === "string" ? row.key.replace(/^composerData:/, "") : undefined
        const parsed = readCursorGlobalComposer(row.value, keyComposerId)
        if (!parsed) {
          continue
        }

        const composerId = parsed.composerId
        const existing = byComposerId.get(composerId)
        if (!existing || (parsed.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
          byComposerId.set(composerId, parsed)
        }
      }
    } catch {
      continue
    }
  }

  return byComposerId
}

async function readCursorTranscriptMap(): Promise<Map<string, string>> {
  const transcriptFiles = await scanFilesByPatterns({
    roots: [cursorTranscriptRoot()],
    patterns: CURSOR_TRANSCRIPT_PATTERNS,
    maxFiles: 400,
  })

  const previews = await Promise.all(
    transcriptFiles.map(async (filePath) => {
      const rawText = await readTextTailSample(filePath, 32_000)
      const preview = extractCursorTranscriptPreview(rawText)
      return preview
        ? {
            composerId: path.basename(filePath, path.extname(filePath)),
            preview,
          }
        : undefined
    }),
  )

  return new Map(
    previews
      .filter((entry): entry is { composerId: string; preview: string } => Boolean(entry))
      .map((entry) => [entry.composerId, entry.preview]),
  )
}

async function listCursorSqliteSessions(mode: LoadMode): Promise<SessionRecord[]> {
  const sqliteFiles = await scanFilesByPatterns({
    roots: [cursorWorkspaceRoot()],
    patterns: CURSOR_WORKSPACE_DB_PATTERNS,
    maxFiles: mode === "fast" ? 40 : 220,
  })

  const workspaceSessions = await Promise.all(
    sqliteFiles.map(async (dbPath) => {
      const stat = await fileStat(dbPath)
      if (!stat) {
        return [] as SessionRecord[]
      }

      const workspacePath = await readWorkspacePathFromWorkspaceJson(dbPath)
      const workspaceLabel = workspacePath ? path.basename(workspacePath) : path.basename(path.dirname(dbPath))

      let composerRows: CursorComposerMeta[] = []
      try {
        composerRows = await withMtimeCache(`cursor:workspace-db:${dbPath}`, stat.mtimeMs, () => {
          const db = new Database(dbPath, { readonly: true })
          const row = db
            .query("SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1")
            .get() as { value?: string } | undefined
          db.close()

          if (typeof row?.value === "string") {
            return readCursorComposerMeta(row.value)
          }

          return [] as CursorComposerMeta[]
        })
      } catch {
        return [] as SessionRecord[]
      }

      return composerRows.map((composer): SessionRecord => {
        const composerMode = composer.unifiedMode
        const titleBase = composer.name ?? workspaceLabel
        const title = titleBase === workspaceLabel && composerMode
          ? `${workspaceLabel} (${composerMode})`
          : titleBase
        const updatedAt =
          composer.updatedAt ??
          composer.createdAt ??
          stat.mtimeMs
        const startedAt = composer.createdAt ?? updatedAt
        const summary = workspacePath

        return buildSessionRecord({
          source: "cursor",
          sourceLabel: "Cursor",
          sessionId: composer.composerId,
          title: truncate(title, 90),
          summary: summary ? truncate(summary, 180) : undefined,
          workspacePath,
          updatedAt,
          startedAt,
          resumeAction: workspacePath
            ? {
                command: "cursor",
                args: ["."],
                cwd: workspacePath,
              }
            : undefined,
          resumeHint: workspacePath
            ? "Opens workspace in Cursor"
            : "Workspace path missing; open Cursor manually.",
        })
      })
    }),
  )

  const sessions = workspaceSessions.flat()
  if (mode === "fast" || sessions.length === 0) {
    return sessions
  }

  const composerIds = new Set(sessions.map((session) => session.sessionId).filter((value): value is string => Boolean(value)))
  const globalComposerMap = await readCursorGlobalComposerMap(composerIds)

  return sessions.map((session) => {
    const globalComposer = session.sessionId ? globalComposerMap.get(session.sessionId) : undefined
    if (!globalComposer) {
      return session
    }

    const mode = globalComposer.unifiedMode
    const workspaceLabel = session.workspacePath ? path.basename(session.workspacePath) : session.title
    const titleBase = globalComposer.name ?? session.title
    const title = titleBase === workspaceLabel && mode
      ? `${workspaceLabel} (${mode})`
      : titleBase

    return buildSessionRecord({
      ...session,
      source: "cursor",
      sourceLabel: "Cursor",
      sessionId: session.sessionId,
      title: truncate(title, 90),
      summary: truncate(globalComposer.preview ?? session.summary ?? session.workspacePath ?? session.title, 180),
      workspacePath: session.workspacePath,
      updatedAt: globalComposer.updatedAt ?? session.updatedAt,
      startedAt: globalComposer.createdAt ?? session.startedAt,
      resumeAction: session.resumeAction,
      resumeHint: session.resumeHint,
    })
  })
}

async function listTranscriptFallbackSessions(): Promise<SessionRecord[]> {
  const transcriptFiles = await scanFilesByPatterns({
    roots: [cursorTranscriptRoot()],
    patterns: CURSOR_TRANSCRIPT_PATTERNS,
    maxFiles: 400,
  })

  const sessions = await Promise.all(
    transcriptFiles.map(async (filePath): Promise<SessionRecord | null> => {
      const stat = await fileStat(filePath)
      if (!stat) {
        return null
      }

      const composerId = path.basename(filePath, path.extname(filePath))
      const projectLabel = path.basename(path.dirname(path.dirname(filePath)))
      const preview = await withMtimeCache(`cursor:transcript:${filePath}`, stat.mtimeMs, async () => {
        const rawHead = await readTextSample(filePath, 4096)
        const rawTail = await readTextTailSample(filePath, 32_000)
        return {
          title: extractCursorTranscriptPreview(rawHead) ?? `Agent transcript ${composerId.slice(0, 12)}`,
          summary: extractCursorTranscriptPreview(rawTail),
        }
      })

      return buildSessionRecord({
        source: "cursor",
        sourceLabel: "Cursor",
        sessionId: composerId,
        uidKey: `transcript:${composerId}`,
        title: truncate(preview.title, 90),
        summary: preview.summary ? truncate(preview.summary, 180) : truncate(projectLabel, 180),
        filePath,
        updatedAt: stat.mtimeMs,
        startedAt: stat.birthtimeMs,
        resumeAction: buildOpenFileResumeAction({ filePath }),
        resumeHint: "Opens Cursor agent transcript file",
      })
    }),
  )

  return sessions.filter((session): session is SessionRecord => Boolean(session))
}

function dedupeCursorSessions(sessions: SessionRecord[]): SessionRecord[] {
  const byKey = new Map<string, SessionRecord>()

  for (const session of sessions) {
    const dedupeKey = session.sessionId ? `cursor:${session.sessionId}` : session.uid
    const existing = byKey.get(dedupeKey)
    if (!existing || session.updatedAt > existing.updatedAt) {
      byKey.set(dedupeKey, {
        ...session,
        uid: dedupeKey,
      })
    }
  }

  return Array.from(byKey.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

export const cursorSource: SessionSource = {
  id: "cursor",
  label: "Cursor",
  async listSessions(mode: LoadMode = "full"): Promise<SessionRecord[]> {
    const fromSqlite = await listCursorSqliteSessions(mode)
    if (fromSqlite.length > 0) {
      return dedupeCursorSessions(fromSqlite)
    }

    return dedupeCursorSessions(await listTranscriptFallbackSessions())
  },
}
