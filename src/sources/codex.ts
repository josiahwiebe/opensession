import path from "node:path"
import * as v from "valibot"
import type { LoadMode, SessionRecord, SessionSource } from "../types"
import {
  envPath,
  fileStat,
  readTextSample,
  readTextTailSample,
  scanFilesByPatterns,
} from "../utils/fs"
import { truncate } from "../utils/format"
import {
  buildSessionRecord,
  normalizeTimestamp,
  parseJsonLines,
  parseWithSchema,
  textFromContent,
} from "./shared"

function codexRoots(): string[] {
  return [envPath("CODEX_HOME") ?? "~/.codex"]
}

const CODEX_PATTERNS = [
  "sessions/*/*/*/rollout-*.jsonl",
  "sessions/**/*.jsonl",
]

interface ParsedCodexMeta {
  sessionId?: string
  title?: string
  summary?: string
  workspacePath?: string
  startedAt?: number
}

const CodexLineSchema = v.object({
  type: v.string(),
  payload: v.optional(v.unknown()),
})

const CodexSessionMetaPayloadSchema = v.object({
  id: v.optional(v.string()),
  cwd: v.optional(v.string()),
  timestamp: v.optional(v.string()),
})

const CodexEventPayloadSchema = v.object({
  type: v.string(),
  message: v.optional(v.string()),
})

const CodexMessagePayloadSchema = v.object({
  type: v.literal("message"),
  role: v.union([v.literal("user"), v.literal("assistant")]),
  content: v.array(v.object({ type: v.optional(v.string()), text: v.optional(v.string()) })),
})

function candidateUserText(text: string): string | undefined {
  const stripped = text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/gi, " ")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, " ")

  const normalized = stripped.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return undefined
  }

  const noisePrefixes = [
    "# AGENTS.md instructions",
    "<permissions instructions>",
    "<collaboration_mode>",
  ]

  if (noisePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return undefined
  }

  if (normalized.startsWith("<") && normalized.endsWith(">") && !normalized.includes(" ")) {
    return undefined
  }

  if (normalized.length < 4) {
    return undefined
  }

  return normalized
}

/** Parses Codex JSONL transcript lines into the metadata we display. */
export function parseCodexSession(rawText: string): ParsedCodexMeta {
  let sessionId: string | undefined
  let workspacePath: string | undefined
  let startedAt: number | undefined
  const userMessages: string[] = []
  let assistantPreview: string | undefined

  for (const line of parseJsonLines(rawText)) {
    const parsedLine = parseWithSchema(CodexLineSchema, line)
    if (!parsedLine?.payload) {
      continue
    }

    if (parsedLine.type === "session_meta") {
      const payload = parseWithSchema(CodexSessionMetaPayloadSchema, parsedLine.payload)
      if (!payload) {
        continue
      }

      if (payload.id) {
        sessionId = payload.id
      }
      if (payload.cwd) {
        workspacePath = payload.cwd
      }
      startedAt = normalizeTimestamp(payload.timestamp)
      continue
    }

    if (parsedLine.type === "event_msg") {
      const payload = parseWithSchema(CodexEventPayloadSchema, parsedLine.payload)
      if (!payload?.message) {
        continue
      }

      const candidate = candidateUserText(payload.message)
      if (!candidate) {
        continue
      }

      if (payload.type === "user_message") {
        userMessages.push(candidate)
        continue
      }

      if (!assistantPreview && payload.type === "agent_message") {
        assistantPreview = candidate
      }

      continue
    }

    const payload = parseWithSchema(CodexMessagePayloadSchema, parsedLine.payload)
    if (!payload) {
      continue
    }

    if (payload.role === "user") {
      const candidate = candidateUserText(
        textFromContent(payload.content, (part) => part.type === "input_text") ?? "",
      )
      if (candidate) {
        userMessages.push(candidate)
      }
    }

    if (!assistantPreview && payload.role === "assistant") {
      const candidate = candidateUserText(
        textFromContent(payload.content, (part) => part.type === "output_text") ?? "",
      )
      if (candidate) {
        assistantPreview = candidate
      }
    }
  }

  const title = userMessages[0]
    ? truncate(userMessages[0], 90)
    : assistantPreview
      ? truncate(assistantPreview, 90)
      : undefined

  const summary = userMessages[1]
    ? truncate(userMessages[1], 180)
    : assistantPreview
      ? truncate(assistantPreview, 180)
      : undefined

  return {
    sessionId,
    workspacePath,
    title,
    summary,
    startedAt,
  }
}

export const codexSource: SessionSource = {
  id: "codex",
  label: "Codex",
  async listSessions(mode: LoadMode = "full"): Promise<SessionRecord[]> {
    const files = await scanFilesByPatterns({
      roots: codexRoots(),
      patterns: CODEX_PATTERNS,
      maxFiles: mode === "fast" ? 36 : 180,
    })

    const sessions = await Promise.all(
      files.map(async (filePath): Promise<SessionRecord | null> => {
        const stat = await fileStat(filePath)
        if (!stat) {
          return null
        }

        const rawText = await readTextSample(filePath, 64_000)
        const tailText = await readTextTailSample(filePath, 64_000)
        const parsed = parseCodexSession(`${rawText}\n${tailText}`)
        const fallbackName = path.basename(filePath)
        const sessionId = parsed.sessionId ?? fallbackName.replace(/\.(jsonl?|md)$/i, "")

        return buildSessionRecord({
          source: "codex",
          sourceLabel: "Codex",
          sessionId,
          title: parsed.title ?? fallbackName,
          summary: parsed.summary,
          workspacePath: parsed.workspacePath,
          filePath,
          updatedAt: stat.mtimeMs,
          startedAt: parsed.startedAt ?? stat.birthtimeMs,
          resumeAction: {
            command: "codex",
            args: ["resume", sessionId],
          },
          resumeHint: "Runs `codex resume <session-id>`",
        })
      }),
    )

    return sessions.filter((session: SessionRecord | null): session is SessionRecord => Boolean(session))
  },
}
