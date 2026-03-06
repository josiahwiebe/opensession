export function prettySource(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

export function formatTimestamp(value?: number): string {
  if (!value) {
    return "unknown"
  }

  return new Date(value).toLocaleString()
}

export function formatRelative(value?: number): string {
  if (!value) {
    return "unknown"
  }

  const elapsedMs = Date.now() - value
  const minute = 60_000
  const hour = minute * 60
  const day = hour * 24

  if (elapsedMs < minute) {
    return "just now"
  }

  if (elapsedMs < hour) {
    return `${Math.round(elapsedMs / minute)}m ago`
  }

  if (elapsedMs < day) {
    return `${Math.round(elapsedMs / hour)}h ago`
  }

  return `${Math.round(elapsedMs / day)}d ago`
}

export function truncate(value: string, max = 120): string {
  if (value.length <= max) {
    return value
  }

  return `${value.slice(0, Math.max(0, max - 1))}…`
}
