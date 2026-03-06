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

export interface SessionSource {
  id: SessionSourceId
  label: string
  listSessions: () => Promise<SessionRecord[]>
}
