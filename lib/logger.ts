type LogLevel = "debug" | "info" | "warn" | "error"

interface SerializedError {
  name: string
  message: string
  stack?: string
}

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  details?: unknown
  error?: SerializedError
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: "NonError", message: typeof error === "string" ? error : JSON.stringify(error) ?? String(error) }
}

function write(level: LogLevel, message: string, details?: unknown, error?: unknown): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(details !== undefined && { details }),
    ...(error !== undefined && { error: serializeError(error) }),
  }
  const out = level === "error" || level === "warn" ? console.error : console.log
  out(JSON.stringify(entry))
}

/** Structured one-line JSON logs. Never pass emails, prompts or guide content. */
const Logger = {
  debug(message: string, details?: unknown): void {
    if (process.env.NODE_ENV !== "production") write("debug", message, details)
  },
  info(message: string, details?: unknown): void {
    write("info", message, details)
  },
  warn(message: string, details?: unknown, error?: unknown): void {
    write("warn", message, details, error)
  },
  error(message: string, error?: unknown, details?: unknown): void {
    write("error", message, details, error)
  },
}

export default Logger
