import "server-only"
import { OpenAI } from "openai"
import { wrapOpenAI } from "langsmith/wrappers"

export class MissingOpenAIKeyError extends Error {
  constructor() {
    super("OPENAI_API_KEY is not set")
    this.name = "MissingOpenAIKeyError"
  }
}

/** Per-request timeout. The SDK retries 429/5xx/timeouts itself with backoff. */
export const OPENAI_TIMEOUT_MS = 60_000
export const OPENAI_MAX_RETRIES = 2

let client: OpenAI | undefined

/**
 * The shared OpenAI client, created on first use (never at import time) and
 * wrapped with LangSmith tracing when LANGSMITH_TRACING=true and a key is set.
 */
export function getOpenAIClient(): OpenAI {
  if (client) return client
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new MissingOpenAIKeyError()

  const base = new OpenAI({ apiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: OPENAI_MAX_RETRIES })
  const tracing = process.env.LANGSMITH_TRACING === "true" && !!process.env.LANGSMITH_API_KEY
  client = tracing ? wrapOpenAI(base) : base
  return client
}
