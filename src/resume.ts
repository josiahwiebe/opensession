import type { SessionRecord } from "./types"

/** Executes the selected session's resume command in the foreground shell. */
export async function resumeSession(session: SessionRecord): Promise<number> {
  if (!session.resumeAction) {
    return 2
  }

  const proc = Bun.spawn({
    cmd: [session.resumeAction.command, ...session.resumeAction.args],
    cwd: session.resumeAction.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  return proc.exited
}
