import path from "node:path"
import { Database } from "bun:sqlite"
import type { SessionRecord, SessionSource } from "../types"
import { fileStat, platform, readTextSample, scanFilesByPatterns } from "../utils/fs"
import { truncate } from "../utils/format"
import { parseJsonSafe, scanFileBackedSessions } from "./shared"

/** De-duplicates path candidates while preserving order. */
function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths))
}

function cursorRoots(): string[] {
  if (platform() === "darwin") {
    return uniquePaths([
      "~/Library/Application Support/Cursor/User/workspaceStorage",
      "~/Library/Application Support/Cursor/User/globalStorage",
      "~/Library/Application Support/cursor/User/workspaceStorage",
      "~/Library/Application Support/cursor/User/globalStorage",
      "~/Library/Application Support/Cursor - Insiders/User/workspaceStorage",
      "~/Library/Application Support/Cursor - Insiders/User/globalStorage",
      "~/.cursor",
    ])
  }

  return uniquePaths([
    "~/.config/Cursor/User/workspaceStorage",
    "~/.config/Cursor/User/globalStorage",
    "~/.config/cursor/User/workspaceStorage",
    "~/.config/cursor/User/globalStorage",
    "~/.local/share/Cursor/User/workspaceStorage",
    "~/.local/share/cursor/User/workspaceStorage",
    "~/.cursor",
  ])
}

const CURSOR_PATTERNS = [
  "**/chatSessions/*.json",
  "**/chatSessions/*.jsonl",
  "**/sessions/*.json",
  "**/sessions/*.jsonl",
  "**/chat/sessions/*.json",
  "**/chat/sessions/*.jsonl",
]

const CURSOR_SQLITE_PATTERNS = ["**/state.vscdb"]

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

function readWorkspacePath(rawText: string): string | undefined {
  const parsedWhole = parseJsonSafe(rawText)
  if (parsedWhole && typeof parsedWhole === "object") {
    const direct = readWorkspacePathFromObject(parsedWhole)
    if (direct) {
      return direct
    }
  }

  const lines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const parsedLine = parseJsonSafe(line)
    if (!parsedLine || typeof parsedLine !== "object") {
      continue
    }

    const fromLine = readWorkspacePathFromObject(parsedLine)
    if (fromLine) {
      return fromLine
    }
  }

  return undefined
}

interface CursorComposerMeta {
  composerId: string
  createdAt?: number
  unifiedMode?: string
}

function normalizeCursorTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined
  }

  return value > 10_000_000_000 ? value : value * 1000
}

function readComposerMeta(rawValue: string): CursorComposerMeta[] {
  const parsed = parseJsonSafe(rawValue)
  if (!parsed || typeof parsed !== "object") {
    return []
  }

  const allComposers = (parsed as Record<string, unknown>).allComposers
  if (!Array.isArray(allComposers)) {
    return []
  }

  const parsedRows: CursorComposerMeta[] = []

  for (const entry of allComposers) {
    if (!entry || typeof entry !== "object") {
      continue
    }

    const objectEntry = entry as Record<string, unknown>
    const composerId = objectEntry.composerId
    if (typeof composerId !== "string" || composerId.length === 0) {
      continue
    }

    parsedRows.push({
      composerId,
      createdAt: normalizeCursorTimestamp(objectEntry.createdAt),
      unifiedMode: typeof objectEntry.unifiedMode === "string" ? objectEntry.unifiedMode : undefined,
    })
  }

  return parsedRows
}

async function readWorkspacePathFromWorkspaceJson(dbPath: string): Promise<string | undefined> {
  const workspaceJsonPath = path.join(path.dirname(dbPath), "workspace.json")
  const raw = await readTextSample(workspaceJsonPath, 4096)
  if (!raw) {
    return undefined
  }

  return readWorkspacePath(raw)
}

async function listCursorSqliteSessions(): Promise<SessionRecord[]> {
  const sqliteFiles = await scanFilesByPatterns({
    roots: cursorRoots(),
    patterns: CURSOR_SQLITE_PATTERNS,
    maxFiles: 220,
  })

  const sessions = await Promise.all(
    sqliteFiles.map(async (dbPath) => {
      const stat = await fileStat(dbPath)
      if (!stat) {
        return [] as SessionRecord[]
      }

      const workspacePath = await readWorkspacePathFromWorkspaceJson(dbPath)
      const workspaceLabel = workspacePath ? path.basename(workspacePath) : path.basename(path.dirname(dbPath))

      let composerRows: CursorComposerMeta[] = []
      try {
        const db = new Database(dbPath, { readonly: true })
        const row = db
          .query("SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1")
          .get() as { value?: string } | undefined
        db.close()

        if (typeof row?.value === "string") {
          composerRows = readComposerMeta(row.value)
        }
      } catch {
        return [] as SessionRecord[]
      }

      return composerRows.map((composer): SessionRecord => {
        const occurredAt = composer.createdAt ?? stat.mtimeMs
        const modeLabel = composer.unifiedMode ? ` (${composer.unifiedMode})` : ""

        return {
          uid: `cursor:${composer.composerId}:${path.dirname(dbPath)}`,
          source: "cursor",
          sourceLabel: "Cursor",
          sessionId: composer.composerId,
          title: truncate(`${workspaceLabel}${modeLabel}`, 90),
          summary: workspacePath ? truncate(workspacePath, 180) : undefined,
          workspacePath,
          updatedAt: occurredAt,
          startedAt: occurredAt,
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
        }
      })
    }),
  )

  return sessions.flat()
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
  async listSessions(): Promise<SessionRecord[]> {
    const fromSqlite = await listCursorSqliteSessions()
    if (fromSqlite.length > 0) {
      return dedupeCursorSessions(fromSqlite)
    }

    const fromJsonFiles = await scanFileBackedSessions({
      source: "cursor",
      sourceLabel: "Cursor",
      roots: cursorRoots(),
      patterns: CURSOR_PATTERNS,
      maxFiles: 120,
      buildResumeHint: () => "Uses workspace open fallback when available",
    })

    const fromJsonFilesEnriched = await Promise.all(
      fromJsonFiles.map(async (session) => {
        const rawText = session.filePath ? await Bun.file(session.filePath).slice(0, 16_384).text() : ""
        const workspacePath = readWorkspacePath(rawText)
        const fallbackTitle = session.sessionId ? `Session ${session.sessionId.slice(0, 12)}` : session.title
        const safeTitle = looksLikeCodeSnippet(session.title) ? fallbackTitle : session.title
        const safeSummary = looksLikeCodeSnippet(session.summary) ? undefined : session.summary

        if (!workspacePath) {
          return {
            ...session,
            title: safeTitle,
            summary: safeSummary,
            resumeAction: undefined,
            resumeHint: "No stable Cursor session-resume CLI. Open the file manually.",
          }
        }

        return {
          ...session,
          title: safeTitle,
          summary: safeSummary,
          workspacePath,
          resumeAction: {
            command: "cursor",
            args: ["."],
            cwd: workspacePath,
          },
          resumeHint: "Opens workspace in Cursor",
        }
      }),
    )

    return dedupeCursorSessions(fromJsonFilesEnriched)
  },
}
