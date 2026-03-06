import path from "node:path"
import type { SessionRecord, SessionSource } from "../types"
import { fileStat } from "../utils/fs"
import { prettySource, truncate } from "../utils/format"
import { parseJsonSafe, scanFileBackedSessions } from "./shared"

const FALLBACK_ROOTS = [
  "~/.local/share/opencode",
  "~/Library/Application Support/opencode",
  "~/.config/opencode",
]

const FALLBACK_PATTERNS = [
  "sessions/**/*.json",
  "sessions/**/*.jsonl",
  "**/*session*.json",
  "**/*session*.jsonl",
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

async function listFallback(): Promise<SessionRecord[]> {
  return scanFileBackedSessions({
    source: "opencode",
    sourceLabel: prettySource("opencode"),
    roots: FALLBACK_ROOTS,
    patterns: FALLBACK_PATTERNS,
    maxFiles: 120,
    buildResumeAction: ({ sessionId, filePath }) => ({
      command: "opencode",
      args: sessionId ? ["--session", sessionId] : ["run", "--continue", "--file", filePath],
    }),
    buildResumeHint: ({ filePath }) => {
      const relativeName = path.basename(filePath)
      return `OpenCode fallback from ${relativeName}`
    },
  })
}

export const opencodeSource: SessionSource = {
  id: "opencode",
  label: "OpenCode",
  async listSessions(): Promise<SessionRecord[]> {
    const fromCli = runOpenCodeSessionList()
    if (fromCli.length > 0) {
      return fromCli
    }

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

    return enriched
  },
}
