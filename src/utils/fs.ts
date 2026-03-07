import os from "node:os"
import path from "node:path"
import { access } from "node:fs/promises"

export const HOME_DIR = os.homedir()

/** De-duplicates path candidates while preserving order. */
export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const candidate of paths) {
    const normalized = candidate.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    ordered.push(normalized)
  }

  return ordered
}

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

/** Returns a trimmed environment path when set. */
export function envPath(key: string): string | undefined {
  const value = process.env[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/** Returns the XDG data home, matching `xdg-basedir`. */
export function xdgDataHome(): string {
  return envPath("XDG_DATA_HOME") ?? path.join(HOME_DIR, ".local", "share")
}

/** Returns likely macOS Application Support roots for the provided app names. */
export function macosAppSupportRoots(appNames: string[]): string[] {
  return uniquePaths(appNames.map((appName) => path.join(HOME_DIR, "Library", "Application Support", appName)))
}

/** Returns likely Linux XDG config/data/state roots for the provided app names. */
export function linuxXdgRoots(appNames: string[]): string[] {
  const configHome = envPath("XDG_CONFIG_HOME") ?? path.join(HOME_DIR, ".config")
  const dataHome = envPath("XDG_DATA_HOME") ?? path.join(HOME_DIR, ".local", "share")
  const stateHome = envPath("XDG_STATE_HOME") ?? path.join(HOME_DIR, ".local", "state")

  return uniquePaths(
    appNames.flatMap((appName) => [
      path.join(configHome, appName),
      path.join(dataHome, appName),
      path.join(stateHome, appName),
    ]),
  )
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

/** Reads a small trailing slice from a text file. */
export async function readTextTailSample(filePath: string, maxBytes = 16_384): Promise<string> {
  try {
    const file = Bun.file(filePath)
    const stat = await file.stat()
    const start = Math.max(0, stat.size - maxBytes)
    return await file.slice(start, stat.size).text()
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
  const roots = uniquePaths(options.roots.map(expandHome))
  const discovered = new Set<string>()
  const hardLimit = Math.max(maxFiles * 12, 1200)
  const perRootLimit = Math.max(Math.ceil((maxFiles * 4) / Math.max(roots.length, 1)), 150)

  for (const root of roots) {
    if (!(await pathExists(root))) {
      continue
    }

    let discoveredFromRoot = 0

    for (const pattern of options.patterns) {
      const glob = new Bun.Glob(pattern)
      for await (const filePath of glob.scan({
        cwd: root,
        absolute: true,
        dot: true,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        const before = discovered.size
        discovered.add(filePath)
        if (discovered.size > before) {
          discoveredFromRoot += 1
        }

        if (discoveredFromRoot >= perRootLimit || discovered.size >= hardLimit) {
          break
        }
      }

      if (discoveredFromRoot >= perRootLimit || discovered.size >= hardLimit) {
        break
      }
    }

    if (discovered.size >= hardLimit) {
      break
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
