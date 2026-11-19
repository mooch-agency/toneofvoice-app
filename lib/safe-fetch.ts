import "server-only"
import { lookup as dnsLookup } from "node:dns/promises"
import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { isIP, type LookupFunction } from "node:net"
import type { Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { UnsafeUrlError, isPublicIpAddress, type LookupFn } from "./url-validation"

/**
 * A single GET for user-supplied URLs that closes the DNS-rebinding gap.
 *
 * `assertPublicHttpUrl` checks the DNS answer, but `fetch` then does its own
 * lookup, so a hostile resolver can answer "public" for the check and
 * "127.0.0.1" for the connection. Here the socket's own `lookup` hook resolves
 * the host, rejects unless every address is allowed, and hands exactly those
 * addresses to the socket: the IP that is checked is the IP that is connected
 * to. IP-literal hosts never reach `lookup`, so they are checked up front.
 *
 * Redirects are not followed: the caller gets the status and Location header
 * and must validate the next hop itself.
 */

export interface SafeGetOptions {
  /** Hard deadline for the whole request, headers and body included (tarpits, slow drips). */
  timeoutMs: number
  /** Stop reading (and close the connection) after this many decoded body bytes. */
  maxBytes: number
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Resolver for hostnames. Defaults to the system resolver. Tests inject a fake. */
  lookup?: LookupFn
  /** Which resolved or literal addresses may be connected to. Defaults to public unicast only. */
  isAllowedAddress?: (address: string) => boolean
}

export interface SafeGetResponse {
  status: number
  headers: Headers
  /** Body decoded as UTF-8; empty for redirects; truncated at `maxBytes`. */
  body: string
  url: URL
}

const systemLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

class TimeoutError extends Error {
  constructor() {
    super("Request timed out")
    this.name = "TimeoutError"
  }
}

async function resolveAllowed(
  hostname: string,
  lookup: LookupFn,
  isAllowed: (address: string) => boolean,
): Promise<{ address: string; family: number }[]> {
  let answers: { address: string }[]
  try {
    answers = await lookup(hostname)
  } catch {
    throw new UnsafeUrlError("Hostname could not be resolved")
  }
  if (answers.length === 0) throw new UnsafeUrlError("Hostname could not be resolved")
  if (!answers.every((a) => isAllowed(a.address))) {
    throw new UnsafeUrlError("Hostname resolves to a non-public address")
  }
  return answers.map(({ address }) => ({ address, family: isIP(address) }))
}

/** A socket `lookup` hook that only ever yields addresses that passed `isAllowed`. */
function guardedLookup(lookup: LookupFn, isAllowed: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolveAllowed(hostname, lookup, isAllowed).then(
      (answers) => {
        const wanted = options.family === 4 || options.family === 6 ? answers.filter((a) => a.family === options.family) : answers
        if (wanted.length === 0) return callback(new UnsafeUrlError("Hostname could not be resolved"), "", 0)
        if (options.all) callback(null, wanted)
        else callback(null, wanted[0].address, wanted[0].family)
      },
      (err: Error) => callback(err, "", 0),
    )
  }
}

function toHeaders(raw: string[]): Headers {
  const headers = new Headers()
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      headers.append(raw[i], raw[i + 1])
    } catch {
      // Skip header values the Fetch Headers class refuses.
    }
  }
  return headers
}

function decodedBody(res: IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase()
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(createGunzip())
  if (encoding === "deflate") return res.pipe(createInflate())
  if (encoding === "br") return res.pipe(createBrotliDecompress())
  return res
}

export async function safeGet(input: string | URL, opts: SafeGetOptions): Promise<SafeGetResponse> {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new UnsafeUrlError("Invalid URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https URLs are allowed")
  }

  const host = url.hostname.replace(/^\[|\]$/g, "")
  const isAllowed = opts.isAllowedAddress ?? isPublicIpAddress
  const literal = isIP(host) !== 0
  // Node skips `lookup` for IP literals, so they must be checked here.
  if (literal && !isAllowed(host)) throw new UnsafeUrlError("Address not allowed")

  const { signal, timeoutMs, maxBytes } = opts
  signal?.throwIfAborted()

  const https = url.protocol === "https:"
  const req = (https ? httpsRequest : httpRequest)({
    protocol: url.protocol,
    hostname: host,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: { "Accept-Encoding": "gzip, deflate, br", ...opts.headers },
    // A fresh connection per request: no pooled socket from an earlier lookup is reused.
    agent: false,
    lookup: literal ? undefined : guardedLookup(opts.lookup ?? systemLookup, isAllowed),
    // SNI and certificate checks use the hostname, never the resolved IP.
    ...(https && !literal ? { servername: host } : {}),
  })

  return new Promise<SafeGetResponse>((resolve, reject) => {
    let settled = false
    let decoder: Readable | undefined // zlib stream, if the body is compressed

    const finish = () => {
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      decoder?.destroy()
      req.destroy()
    }
    const fail = (err: unknown) => {
      if (settled) return
      finish()
      reject(err)
    }
    const succeed = (res: IncomingMessage, chunks: Buffer[]) => {
      if (settled) return
      finish()
      resolve({
        status: res.statusCode ?? 0,
        headers: toHeaders(res.rawHeaders),
        body: Buffer.concat(chunks).toString("utf8"),
        url,
      })
    }

    const timer = setTimeout(() => fail(new TimeoutError()), timeoutMs)
    const onAbort = () => fail(signal?.reason ?? new Error("Request aborted"))
    signal?.addEventListener("abort", onAbort, { once: true })

    req.on("error", fail)
    req.on("response", (res) => {
      res.on("error", fail)
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) return succeed(res, [])

      const chunks: Buffer[] = []
      let received = 0
      const body = decodedBody(res)
      if (body !== res) decoder = body
      body.on("error", fail)
      body.on("data", (chunk: Buffer) => {
        if (settled) return
        const take = chunk.subarray(0, maxBytes - received)
        chunks.push(take)
        received += take.byteLength
        if (received >= maxBytes) succeed(res, chunks)
      })
      body.on("end", () => succeed(res, chunks))
    })
    req.end()
  })
}
