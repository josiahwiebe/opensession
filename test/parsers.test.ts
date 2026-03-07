import { describe, expect, test } from "bun:test"
import { parseClaudeSession } from "../src/sources/claude"
import { parseCodexSession } from "../src/sources/codex"
import {
  extractCursorTranscriptPreview,
  readCursorComposerMeta,
  readCursorGlobalComposer,
} from "../src/sources/cursor"
import { parseGeminiSession } from "../src/sources/gemini"

async function readFixture(name: string): Promise<string> {
  return Bun.file(new URL(`./fixtures/sources/${name}`, import.meta.url)).text()
}

describe("session parsers", () => {
  test("parses Gemini session metadata from fixture JSON", async () => {
    const rawText = await readFixture("gemini-session.json")
    const parsed = parseGeminiSession(rawText, "/tmp/session-1.json")

    expect(parsed).toBeDefined()
    expect(parsed?.sessionId).toBe("11111111-1111-1111-1111-111111111111")
    expect(parsed?.title).toBe("Investigate caching bug")
    expect(parsed?.summary).toBe("Found root cause in cache key generation. - subagent session")
    expect(parsed?.workspacePath).toBe("/tmp/gemini-workspace")
    expect(parsed?.startedAt).toBe(Date.parse("2026-03-01T10:00:00.000Z"))
    expect(parsed?.updatedAt).toBe(Date.parse("2026-03-01T10:05:00.000Z"))
  })

  test("parses Codex session metadata from fixture JSONL", async () => {
    const rawText = await readFixture("codex-rollout.jsonl")
    const parsed = parseCodexSession(rawText)

    expect(parsed.sessionId).toBe("22222222-2222-2222-2222-222222222222")
    expect(parsed.title).toBe("Build a session browser")
    expect(parsed.summary).toBe("Implemented the browser UI.")
    expect(parsed.workspacePath).toBe("/tmp/codex-workspace")
    expect(parsed.startedAt).toBe(Date.parse("2026-03-02T09:00:00.000Z"))
  })

  test("parses Claude transcript metadata from fixture JSONL", async () => {
    const rawText = await readFixture("claude-transcript.jsonl")
    const parsed = parseClaudeSession(rawText, "/tmp/claude-session.jsonl")

    expect(parsed).toBeDefined()
    expect(parsed?.sessionId).toBe("claude-session-123")
    expect(parsed?.title).toBe("Follow up request")
    expect(parsed?.summary).toBe("Latest assistant answer")
    expect(parsed?.workspacePath).toBe("/tmp/claude-workspace")
    expect(parsed?.startedAt).toBe(Date.parse("2026-03-03T10:00:00.000Z"))
    expect(parsed?.updatedAt).toBe(Date.parse("2026-03-03T10:03:00.000Z"))
  })

  test("parses Cursor workspace composer metadata", () => {
    const parsed = readCursorComposerMeta(
      JSON.stringify({
        allComposers: [
          {
            composerId: "cursor-composer-1",
            name: "Fix Cursor session listing",
            createdAt: 1772800000000,
            lastUpdatedAt: 1772800100000,
            unifiedMode: "agent",
          },
        ],
      }),
    )

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.composerId).toBe("cursor-composer-1")
    expect(parsed[0]?.name).toBe("Fix Cursor session listing")
    expect(parsed[0]?.updatedAt).toBe(1772800100000)
    expect(parsed[0]?.unifiedMode).toBe("agent")
  })

  test("parses Cursor global composer preview from conversation map", () => {
    const parsed = readCursorGlobalComposer(
      JSON.stringify({
        composerId: "cursor-composer-1",
        name: "Fix Cursor session listing",
        createdAt: 1772800000000,
        lastUpdatedAt: 1772800100000,
        unifiedMode: "agent",
        conversation: [
          { bubbleId: "user-1", type: 1 },
          { bubbleId: "assistant-1", type: 2, text: "The chats are stored in workspaceStorage and enriched by transcripts." },
        ],
      }),
    )

    expect(parsed?.composerId).toBe("cursor-composer-1")
    expect(parsed?.name).toBe("Fix Cursor session listing")
    expect(parsed?.preview).toBe("The chats are stored in workspaceStorage and enriched by transcripts.")
  })

  test("extracts latest readable Cursor transcript preview", () => {
    const preview = extractCursorTranscriptPreview([
      "User: find the bug",
      "```ts",
      "const broken = true",
      "```",
      "Assistant: the regression is in the global state index.",
    ].join("\n"))

    expect(preview).toBe("Assistant: the regression is in the global state index.")
  })
})
