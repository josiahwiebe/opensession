import { startTui } from "./ui"

try {
  await startTui()
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error("Failed to start open-session-mgr")
  console.error(message)
  process.exit(1)
}
