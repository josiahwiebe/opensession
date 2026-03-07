import path from "node:path"
import * as v from "valibot"
import type { SessionRecord, SessionSourceId } from "../types"
import { defaultFileOpenCommand, fileStat, readTextSample, scanFilesByPatterns } from "../utils/fs"
import { prettySource, truncate } from "../utils/format"

export function extractSessionId(value: string): string | undefined {
  const uuidMatch = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (uuidMatch?.[0]) {
    return uuidMatch[0]
  }

  const name = path.basename(value).replace(/\.(jsonl?|md)$/i, "")
  if (name.length > 8) {
    return name
  }

  return undefined
}

/** Extracts a display title from sampled transcript content. */
export function extractLikelyTitle(rawContent: string, fallback: string): string {
  const titlePatterns = [
    /"title"\s*:\s*"([^"]+)"/i,
    /"name"\s*:\s*"([^"]+)"/i,
    /"summary"\s*:\s*"([^"]+)"/i,
    /"content"\s*:\s*"([^"]{12,120})"/i,
  ]

  for (const pattern of titlePatterns) {
    const match = rawContent.match(pattern)
    if (match?.[1]) {
      return truncate(cleanQuoted(match[1]), 90)
    }
  }

  return truncate(fallback, 90)
}

/** Extracts a short summary from sampled transcript content. */
export function extractLikelySummary(rawContent: string): string | undefined {
  const patterns = [
    /"summary"\s*:\s*"([^"]{12,240})"/i,
    /"message"\s*:\s*"([^"]{12,240})"/i,
    /"content"\s*:\s*"([^"]{12,240})"/i,
  ]

  for (const pattern of patterns) {
    const match = rawContent.match(pattern)
    if (match?.[1]) {
      return truncate(cleanQuoted(match[1]), 180)
    }
  }

  return undefined
}

function cleanQuoted(value: string): string {
  return value.replace(/\\n/g, " ").replace(/\\"/g, '"').trim()
}

const TextPartSchema = v.object({
  type: v.optional(v.string()),
  text: v.optional(v.string()),
})

type TextPart = v.InferOutput<typeof TextPartSchema>

export function parseWithSchema<const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: TSchema,
  value: unknown,
): v.InferOutput<TSchema> | undefined {
  const result = v.safeParse(schema, value)
  return result.success ? result.output : undefined
}

export function parseJsonWithSchema<const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: TSchema,
  rawText: string,
): v.InferOutput<TSchema> | undefined {
  const parsed = parseJsonSafe(rawText)
  return parsed ? parseWithSchema(schema, parsed) : undefined
}

export function parseJsonLines(rawText: string): unknown[] {
  return rawText
    .split("\n")
    .filter(Boolean)
    .map(parseJsonSafe)
    .filter((value): value is unknown => value !== undefined)
}

export function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  return undefined
}

export function textFromContent(
  content: unknown,
  includePart?: (part: TextPart) => boolean,
): string | undefined {
  if (typeof content === "string") {
    const text = content.trim()
    return text.length > 0 ? text : undefined
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const joined = content
    .map((item) => parseWithSchema(TextPartSchema, item))
    .filter((part): part is TextPart => Boolean(part))
    .filter((part) => !includePart || includePart(part))
    .map((part) => part.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join(" ")
    .trim()

  return joined.length > 0 ? joined : undefined
}

export function buildSessionRecord(params: {
  source: SessionSourceId
  sourceLabel?: string
  sessionId?: string
  uidKey?: string
  title: string
  summary?: string
  filePath?: string
  workspacePath?: string
  updatedAt: number
  startedAt?: number
  resumeAction?: SessionRecord["resumeAction"]
  resumeHint?: string
}): SessionRecord {
  const uidKey = params.uidKey ?? params.sessionId ?? params.filePath ?? params.title

  return {
    uid: `${params.source}:${uidKey}`,
    source: params.source,
    sourceLabel: params.sourceLabel ?? prettySource(params.source),
    sessionId: params.sessionId,
    title: params.title,
    summary: params.summary,
    filePath: params.filePath,
    workspacePath: params.workspacePath,
    updatedAt: params.updatedAt,
    startedAt: params.startedAt,
    resumeAction: params.resumeAction,
    resumeHint: params.resumeHint,
  }
}

export async function scanFileBackedSessions(options: {
  source: SessionSourceId
  sourceLabel?: string
  roots: string[]
  patterns: string[]
  maxFiles?: number
  buildResumeAction?: (params: {
    filePath: string
    sessionId?: string
    workspacePath?: string
  }) => SessionRecord["resumeAction"]
  buildResumeHint?: (params: {
    filePath: string
    sessionId?: string
    workspacePath?: string
  }) => string | undefined
}): Promise<SessionRecord[]> {
  const files = await scanFilesByPatterns({
    roots: options.roots,
    patterns: options.patterns,
    maxFiles: options.maxFiles,
  })

  const sessions = await Promise.all(
    files.map(async (filePath): Promise<SessionRecord | null> => {
      const stat = await fileStat(filePath)
      if (!stat) {
        return null
      }

      const rawContent = await readTextSample(filePath)
      const fileName = path.basename(filePath)
      const sessionId = extractSessionId(filePath)

      const resumeAction =
        options.buildResumeAction?.({ filePath, sessionId }) ??
        buildOpenFileResumeAction({ filePath })

      return buildSessionRecord({
        source: options.source,
        sourceLabel: options.sourceLabel,
        sessionId,
        uidKey: sessionId ?? filePath,
        title: extractLikelyTitle(rawContent, fileName),
        summary: extractLikelySummary(rawContent),
        filePath,
        updatedAt: stat.mtimeMs,
        startedAt: stat.birthtimeMs,
        resumeAction,
        resumeHint: options.buildResumeHint?.({ filePath, sessionId }),
      })
    }),
  )

  return sessions.filter((session): session is SessionRecord => Boolean(session))
}

/** Builds a generic resume action that opens the transcript file. */
export function buildOpenFileResumeAction(params: { filePath: string }): SessionRecord["resumeAction"] {
  const openCommand = defaultFileOpenCommand()
  return {
    command: openCommand.command,
    args: [...openCommand.argsPrefix, params.filePath],
  }
}

/** Parses JSON safely and returns undefined on malformed input. */
export function parseJsonSafe(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
