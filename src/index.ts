import { startTui } from "./ui"

declare const __APP_VERSION__: string | undefined

const APP_NAME = "opensession"
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"

/** Prints command usage details for non-interactive invocation. */
function printHelp(): void {
  console.log(`${APP_NAME} ${APP_VERSION}`)
  console.log("Usage: opensession [--help] [--version]")
  console.log("Run without flags to open the interactive TUI.")
}

const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  printHelp()
  process.exit(0)
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`${APP_NAME} ${APP_VERSION}`)
  process.exit(0)
}

async function main(): Promise<void> {
  await startTui()
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error("Failed to start opensession")
  console.error(message)
  process.exit(1)
})
