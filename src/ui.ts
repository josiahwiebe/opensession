import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
  type Selection,
} from "@opentui/core"
import { resumeSession } from "./resume"
import { loadSessions } from "./sources"
import type { SessionRecord, SessionSourceId } from "./types"
import { formatRelative, formatTimestamp, truncate } from "./utils/format"

interface SessionViewState {
  all: SessionRecord[]
  filtered: SessionRecord[]
  selectedIndex: number
  filterText: string
  sourceFilter: "all" | SessionSourceId
}

interface SourceFilterOption {
  key: "all" | SessionSourceId
  label: string
  description: string
}

interface UiTheme {
  text: string
  accent: string
  mutedText: string
  border: string
  listBackground: string
  listFocusedBackground: string
  listSelectedBackground: string
  listDescription: string
}

const SOURCE_FILTERS: SourceFilterOption[] = [
  { key: "all", label: "All", description: "every client" },
  { key: "claude", label: "Claude", description: "claude code" },
  { key: "codex", label: "Codex", description: "openai codex" },
  { key: "cursor", label: "Cursor", description: "cursor chat" },
  { key: "gemini", label: "Gemini", description: "gemini cli" },
  { key: "opencode", label: "OpenCode", description: "opencode" },
]

function parseHexColor(value: string): { r: number; g: number; b: number } | undefined {
  const match = value.trim().match(/^#?([0-9a-fA-F]{6})$/)
  const hex = match?.[1]
  if (!hex) {
    return undefined
  }

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  }
}

function toHexColor(rgb: { r: number; g: number; b: number }): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`
}

function blendHex(base: string, target: string, amount: number): string {
  const baseRgb = parseHexColor(base)
  const targetRgb = parseHexColor(target)
  if (!baseRgb || !targetRgb) {
    return base
  }

  const mix = Math.max(0, Math.min(1, amount))
  return toHexColor({
    r: baseRgb.r + (targetRgb.r - baseRgb.r) * mix,
    g: baseRgb.g + (targetRgb.g - baseRgb.g) * mix,
    b: baseRgb.b + (targetRgb.b - baseRgb.b) * mix,
  })
}

function isDarkColor(hex: string): boolean {
  const rgb = parseHexColor(hex)
  if (!rgb) {
    return true
  }

  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255
  return luminance < 0.55
}

function buildUiTheme(defaultBackground?: string | null, defaultForeground?: string | null, accentCandidate?: string | null): UiTheme {
  const background = parseHexColor(defaultBackground ?? "") ? (defaultBackground as string) : "#1f2430"
  const foreground = parseHexColor(defaultForeground ?? "") ? (defaultForeground as string) : "#d8dee9"
  const accent = parseHexColor(accentCandidate ?? "") ? (accentCandidate as string) : "#88c0d0"

  const dark = isDarkColor(background)
  return {
    text: foreground,
    accent,
    mutedText: dark ? blendHex(foreground, background, 0.32) : blendHex(foreground, background, 0.45),
    border: dark ? blendHex(background, foreground, 0.22) : blendHex(background, foreground, 0.32),
    listBackground: dark ? blendHex(background, foreground, 0.05) : blendHex(background, foreground, 0.02),
    listFocusedBackground: dark ? blendHex(background, foreground, 0.09) : blendHex(background, foreground, 0.05),
    listSelectedBackground: dark ? blendHex(background, accent, 0.28) : blendHex(background, accent, 0.18),
    listDescription: dark ? blendHex(foreground, background, 0.42) : blendHex(foreground, background, 0.52),
  }
}

function countBySource(sessions: SessionRecord[]): Record<SessionSourceId, number> {
  return sessions.reduce<Record<SessionSourceId, number>>(
    (acc, session) => {
      acc[session.source] += 1
      return acc
    },
    {
      claude: 0,
      codex: 0,
      cursor: 0,
      gemini: 0,
      opencode: 0,
    },
  )
}

function buildClientTabOptions(sessions: SessionRecord[]): Array<{ name: string; description: string }> {
  const counts = countBySource(sessions)
  const total = sessions.length

  return SOURCE_FILTERS.map((option) => {
    const count = option.key === "all" ? total : counts[option.key]
    return {
      name: `${option.label} ${count}`,
      description: option.description,
    }
  })
}

function toSelectName(session: SessionRecord): string {
  return `[${session.sourceLabel}] ${truncate(session.title, 65)}`
}

function toSelectDescription(session: SessionRecord): string {
  return `${formatRelative(session.updatedAt)} ${session.summary ? `- ${truncate(session.summary, 52)}` : ""}`.trim()
}

function renderSessionDetails(session?: SessionRecord): string {
  if (!session) {
    return "No session selected"
  }

  const lines = [
    `Title: ${session.title}`,
    `Source: ${session.sourceLabel}`,
    `Updated: ${formatTimestamp(session.updatedAt)} (${formatRelative(session.updatedAt)})`,
    `Started: ${formatTimestamp(session.startedAt)}`,
    `Session ID: ${session.sessionId ?? "unknown"}`,
  ]

  if (session.summary) {
    lines.push(`Summary: ${session.summary}`)
  }

  if (session.workspacePath) {
    lines.push(`Workspace: ${session.workspacePath}`)
  }

  if (session.filePath) {
    lines.push(`Path: ${session.filePath}`)
  }

  if (session.resumeAction) {
    const command = [session.resumeAction.command, ...session.resumeAction.args].join(" ")
    lines.push(`Resume command: ${command}`)
  } else {
    lines.push("Resume command: unavailable")
  }

  if (session.resumeHint) {
    lines.push(`Hint: ${session.resumeHint}`)
  }

  return lines.join("\n")
}

function applyFilter(state: SessionViewState): void {
  const query = state.filterText.trim().toLowerCase()
  state.filtered = state.all.filter((session) => {
    if (state.sourceFilter !== "all" && session.source !== state.sourceFilter) {
      return false
    }

    if (!query) {
      return true
    }

    const haystack = [
      session.sourceLabel,
      session.title,
      session.summary ?? "",
      session.sessionId ?? "",
      session.filePath ?? "",
      session.workspacePath ?? "",
    ]
      .join(" ")
      .toLowerCase()

    return haystack.includes(query)
  })

  state.selectedIndex = 0
}

function sourceFilterLabel(filter: "all" | SessionSourceId): string {
  const found = SOURCE_FILTERS.find((entry) => entry.key === filter)
  return found?.label ?? "All"
}

/** Starts the OpenTUI app and handles user interaction lifecycle. */
export async function startTui(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    useMouse: true,
    enableMouseMovement: true,
  })

  const palette = await renderer.getPalette().catch(() => undefined)
  const theme = buildUiTheme(
    palette?.defaultBackground,
    palette?.defaultForeground,
    palette?.palette?.[6] ?? palette?.cursorColor,
  )

  const state: SessionViewState = {
    all: [],
    filtered: [],
    selectedIndex: 0,
    filterText: "",
    sourceFilter: "all",
  }

  let focusTarget: "search" | "client" | "list" = "list"
  let statusRestoreTimer: ReturnType<typeof setTimeout> | undefined
  let selectionCopyTimer: ReturnType<typeof setTimeout> | undefined
  let lastCopiedSelectionText = ""

  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    gap: 1,
  })

  const title = new TextRenderable(renderer, {
    content: "Open Session Manager",
    fg: theme.accent,
  })

  const subtitle = new TextRenderable(renderer, {
    content: "Unified chat history for Claude, Cursor, Gemini, OpenCode, and Codex",
    fg: theme.mutedText,
  })

  const filterRow = new BoxRenderable(renderer, {
    width: "100%",
    height: 3,
    borderStyle: "single",
    title: "Filter",
    padding: 0,
    flexDirection: "row",
    gap: 1,
    borderColor: theme.border,
  })

  const filterLabel = new TextRenderable(renderer, {
    content: "Search:",
  })

  const filterInput = new InputRenderable(renderer, {
    width: 60,
    placeholder: "type to filter sessions...",
  })

  filterRow.add(filterLabel)
  filterRow.add(filterInput)

  const clientRow = new BoxRenderable(renderer, {
    width: "100%",
    height: 3,
    borderStyle: "single",
    title: "Client Filter",
    padding: 0,
    borderColor: theme.border,
  })

  const clientTabs = new TabSelectRenderable(renderer, {
    width: 68,
    tabWidth: 14,
    options: buildClientTabOptions(state.all),
    backgroundColor: theme.listBackground,
    textColor: theme.text,
    focusedBackgroundColor: theme.listFocusedBackground,
    focusedTextColor: theme.text,
    selectedBackgroundColor: theme.listSelectedBackground,
    selectedTextColor: theme.text,
    selectedDescriptionColor: theme.mutedText,
    showDescription: false,
    showUnderline: false,
    wrapSelection: true,
  })

  clientRow.add(clientTabs)

  const body = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
  })

  const listPanel = new BoxRenderable(renderer, {
    width: 52,
    flexGrow: 0,
    borderStyle: "single",
    title: "Sessions",
    padding: 1,
    borderColor: theme.border,
  })

  const sessionSelect = new SelectRenderable(renderer, {
    width: 48,
    height: 20,
    options: [],
    backgroundColor: theme.listBackground,
    textColor: theme.text,
    focusedBackgroundColor: theme.listFocusedBackground,
    focusedTextColor: theme.text,
    selectedBackgroundColor: theme.listSelectedBackground,
    selectedTextColor: theme.text,
    descriptionColor: theme.listDescription,
    selectedDescriptionColor: theme.mutedText,
    showDescription: true,
    showScrollIndicator: true,
    wrapSelection: false,
  })

  listPanel.add(sessionSelect)

  const detailsPanel = new BoxRenderable(renderer, {
    flexGrow: 1,
    borderStyle: "single",
    title: "Session Details",
    padding: 1,
    borderColor: theme.border,
  })

  const detailsText = new TextRenderable(renderer, {
    content: "Loading sessions...",
  })

  detailsPanel.add(detailsText)
  body.add(listPanel)
  body.add(detailsPanel)

  const footer = new TextRenderable(renderer, {
    content: "Keys: Tab focus | 1-6 filter | Enter/R resume | Mouse select copies | U refresh | Q quit",
    fg: theme.mutedText,
  })

  const status = new TextRenderable(renderer, {
    content: "Loading...",
  })

  root.add(title)
  root.add(subtitle)
  root.add(filterRow)
  root.add(clientRow)
  root.add(body)
  root.add(footer)
  root.add(status)

  renderer.root.add(root)

  const renderList = () => {
    const options =
      state.filtered.length > 0
        ? state.filtered.map((session) => ({
            name: toSelectName(session),
            description: toSelectDescription(session),
            value: session.uid,
          }))
        : [
            {
              name: "No sessions for this filter",
              description: "Try a different client or clear search",
              value: "__empty__",
            },
          ]

    sessionSelect.options = options

    if (state.filtered.length > 0) {
      const nextIndex = Math.min(state.selectedIndex, options.length - 1)
      sessionSelect.setSelectedIndex(nextIndex)
      state.selectedIndex = nextIndex
      detailsText.content = renderSessionDetails(state.filtered[nextIndex])
    } else {
      sessionSelect.setSelectedIndex(0)
      detailsText.content = "No sessions match the current filter"
    }
  }

  const baseStatusText = () =>
    `Loaded ${state.filtered.length} of ${state.all.length} sessions (${sourceFilterLabel(state.sourceFilter)})`

  const setBaseStatus = () => {
    status.content = baseStatusText()
  }

  const showStatusToast = (message: string, durationMs = 1200) => {
    status.content = message
    if (statusRestoreTimer) {
      clearTimeout(statusRestoreTimer)
    }

    statusRestoreTimer = setTimeout(() => {
      setBaseStatus()
    }, durationMs)
  }

  const syncViewportLayout = () => {
    const estimatedBodyHeight = renderer.height - 18
    sessionSelect.height = Math.max(8, estimatedBodyHeight - 4)

    const clientTabsWidth = Math.max(30, renderer.width - 6)
    clientTabs.width = clientTabsWidth
    clientTabs.tabWidth = Math.max(9, Math.floor(clientTabsWidth / SOURCE_FILTERS.length) - 1)
  }

  const reloadSessions = async () => {
    status.content = "Refreshing sessions..."
    const sessions = await loadSessions()
    state.all = sessions
    const previousIndex = clientTabs.getSelectedIndex()
    clientTabs.setOptions(buildClientTabOptions(state.all))
    clientTabs.setSelectedIndex(Math.max(0, previousIndex))
    applyFilter(state)
    renderList()
    setBaseStatus()
  }

  const launchSelected = async () => {
    const selected = state.filtered[state.selectedIndex]
    if (!selected) {
      status.content = "No session selected"
      return
    }

    if (!selected.resumeAction) {
      status.content = selected.resumeHint ?? "No resume action available for this session"
      return
    }

    const command = [selected.resumeAction.command, ...selected.resumeAction.args].join(" ")
    status.content = `Launching: ${command}`
    await renderer.destroy()
    const exitCode = await resumeSession(selected)
    process.exit(exitCode)
  }

  const copyMouseSelectionToClipboard = (selection: Selection) => {
    if (selectionCopyTimer) {
      clearTimeout(selectionCopyTimer)
    }

    selectionCopyTimer = setTimeout(() => {
      const selectedText = selection.getSelectedText().trim()
      if (!selectedText || selectedText === lastCopiedSelectionText) {
        return
      }

      const copied = renderer.copyToClipboardOSC52(selectedText)
      if (!copied) {
        showStatusToast("Clipboard copy unavailable in this terminal")
        return
      }

      lastCopiedSelectionText = selectedText
      showStatusToast("Copied to clipboard")
    }, 120)
  }

  const clearTransientTimers = () => {
    if (statusRestoreTimer) {
      clearTimeout(statusRestoreTimer)
      statusRestoreTimer = undefined
    }

    if (selectionCopyTimer) {
      clearTimeout(selectionCopyTimer)
      selectionCopyTimer = undefined
    }
  }

  renderer.on("selection", (selection: Selection) => {
    if (!selection) {
      return
    }

    copyMouseSelectionToClipboard(selection)
  })

  sessionSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
    state.selectedIndex = index
    const selected = state.filtered[index]
    detailsText.content = renderSessionDetails(selected)
  })

  sessionSelect.on(SelectRenderableEvents.ITEM_SELECTED, async () => {
    await launchSelected()
  })

  filterInput.on(InputRenderableEvents.INPUT, (value: string) => {
    state.filterText = value
    applyFilter(state)
    renderList()
    setBaseStatus()
  })

  clientTabs.on(TabSelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
    const nextFilter = SOURCE_FILTERS[index]
    if (!nextFilter) {
      return
    }

    state.sourceFilter = nextFilter.key
    applyFilter(state)
    renderList()
    setBaseStatus()
  })

  clientTabs.on(TabSelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    const nextFilter = SOURCE_FILTERS[index]
    if (!nextFilter) {
      return
    }

    state.sourceFilter = nextFilter.key
    applyFilter(state)
    renderList()
    setBaseStatus()
  })

  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    if (key.name === "tab") {
      focusTarget =
        focusTarget === "search" ? "client" : focusTarget === "client" ? "list" : "search"

      if (focusTarget === "search") {
        filterInput.focus()
      } else if (focusTarget === "client") {
        clientTabs.focus()
      } else {
        sessionSelect.focus()
      }
      return
    }

    if (key.name && ["1", "2", "3", "4", "5", "6"].includes(key.name)) {
      const index = Number(key.name) - 1
      const nextFilter = SOURCE_FILTERS[index]
      if (nextFilter) {
        clientTabs.setSelectedIndex(index)
        state.sourceFilter = nextFilter.key
        applyFilter(state)
        renderList()
        setBaseStatus()
      }
      return
    }

    if (key.name === "q") {
      clearTransientTimers()
      await renderer.destroy()
      process.exit(0)
    }

    if (key.name === "u") {
      await reloadSessions()
    }

    if (key.name === "r") {
      await launchSelected()
    }
  })

  renderer.on("resize", () => {
    syncViewportLayout()
  })

  syncViewportLayout()
  await reloadSessions()
  clientTabs.setSelectedIndex(0)
  sessionSelect.focus()
}
