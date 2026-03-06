import os from "node:os"
import path from "node:path"
import { access } from "node:fs/promises"

export const HOME_DIR = os.homedir()

export interface BasicFileStat {
  mtimeMs: number
  birthtimeMs: number
}

/** Returns the current platform string. */
export function platform(): NodeJS.Platform {
  return process.platform
}

/** Expands leading `~` to the active user's home directory. */
export function expandHome(candidate: string): string {
  if (candidate === "~") {
    return HOME_DIR
  }

  if (candidate.startsWith("~/")) {
    return path.join(HOME_DIR, candidate.slice(2))
  }

  return candidate
}

/** Checks whether a path exists on disk. */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/** Reads basic file timestamps needed for sorting and display. */
export async function fileStat(filePath: string): Promise<BasicFileStat | null> {
  try {
    const stat = await Bun.file(filePath).stat()
    return {
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
    }
  } catch {
    return null
  }
}

/** Reads a small leading slice from a text file. */
export async function readTextSample(filePath: string, maxBytes = 16_384): Promise<string> {
  try {
    return await Bun.file(filePath).slice(0, maxBytes).text()
  } catch {
    return ""
  }
}

/** Scans files across roots using multiple glob patterns. */
export async function scanFilesByPatterns(options: {
  roots: string[]
  patterns: string[]
  maxFiles?: number
}): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 300
  const discovered = new Set<string>()

  for (const rootCandidate of options.roots) {
    const root = expandHome(rootCandidate)
    if (!(await pathExists(root))) {
      continue
    }

    for (const pattern of options.patterns) {
      const glob = new Bun.Glob(pattern)
      for await (const filePath of glob.scan({
        cwd: root,
        absolute: true,
        dot: true,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        discovered.add(filePath)
        if (discovered.size >= maxFiles * 3) {
          break
        }
      }

      if (discovered.size >= maxFiles * 3) {
        break
      }
    }
  }

  const withStats = await Promise.all(
    Array.from(discovered).map(async (filePath) => ({
      filePath,
      stat: await fileStat(filePath),
    })),
  )

  return withStats
    .filter((entry) => entry.stat)
    .sort((a, b) => {
      const aTime = a.stat?.mtimeMs ?? 0
      const bTime = b.stat?.mtimeMs ?? 0
      return bTime - aTime
    })
    .slice(0, maxFiles)
    .map((entry) => entry.filePath)
}

/** Returns a cross-platform command used to open a local file. */
export function defaultFileOpenCommand(): { command: string; argsPrefix: string[] } {
  return process.platform === "darwin"
    ? { command: "open", argsPrefix: [] }
    : { command: "xdg-open", argsPrefix: [] }
}
