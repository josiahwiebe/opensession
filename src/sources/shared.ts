import path from "node:path"
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

      return {
        uid: `${options.source}:${sessionId ?? filePath}`,
        source: options.source,
        sourceLabel: options.sourceLabel ?? prettySource(options.source),
        sessionId,
        title: extractLikelyTitle(rawContent, fileName),
        summary: extractLikelySummary(rawContent),
        filePath,
        updatedAt: stat.mtimeMs,
        startedAt: stat.birthtimeMs,
        resumeAction,
        resumeHint: options.buildResumeHint?.({ filePath, sessionId }),
      }
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
