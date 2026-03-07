export type SessionSourceId = "claude" | "codex" | "cursor" | "gemini" | "opencode"

export interface ResumeAction {
  command: string
  args: string[]
  cwd?: string
}

export interface SessionRecord {
  uid: string
  source: SessionSourceId
  sourceLabel: string
  sessionId?: string
  title: string
  summary?: string
  filePath?: string
  workspacePath?: string
  updatedAt: number
  startedAt?: number
  resumeAction?: ResumeAction
  resumeHint?: string
}

export type LoadMode = "fast" | "full"

export interface SessionStreamEvent {
  type: "source-start" | "batch" | "source-complete" | "complete"
  source?: SessionSourceId
  mode?: LoadMode
  sessions?: SessionRecord[]
}

export interface SessionSource {
  id: SessionSourceId
  label: string
  listSessions: (mode?: LoadMode) => Promise<SessionRecord[]>
}
