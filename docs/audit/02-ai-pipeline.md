# 02 - AI / content generation pipeline and pure-logic libraries

Scope: `app/api/{generate-styleguide,expand-style-guide,preview,extract-website,rewrite-section,ai-assist,ai/command,load-template}`, `lib/openai.ts`, `lib/langsmith-openai.ts`, scrapers, `lib/template-processor.ts`, `lib/content-parser.ts`, rules renderer/schema, traits, utils, file-generator, guide-styles, example-guide, logger, blog-prompts, `lib/prompts/*`, `templates/style_guide_template.md`.

Method: read every file in scope, grep for usages across the repo (excluding `node_modules`, `.next`), and reproduce behaviour with throwaway scripts run through `node_modules/.bin/jiti` from the scratchpad (`scratchpad/exp/*.ts`). No repo files were modified. Every finding below was either read directly in code or reproduced. Reproduction output is quoted where it matters.

Severity counts: **critical 1, high 6, medium 10, low 11** (28 findings), plus 20 simplification items.

---

## Findings

### AI-1 - CRITICAL - `/api/generate-styleguide` is unauthenticated: paywall bypass and unmetered OpenAI spend
- **Where:** `app/api/generate-styleguide/route.ts:26-100` (no `supabase.auth.getUser()`, no tier check). `middleware.ts` only protects `/dashboard`. No rate limiting anywhere in the repo (grep `ratelimit|rateLimit`: no hits outside auth-error strings).
- **What's wrong:** The route makes the paid sections (Style Rules, Before/After, Word List, and Audience on the full path) for anyone who POSTs `{brandDetails:{name, brandDetailsDescription}}`. Compare `expand-style-guide/route.ts:8-42`, which requires auth plus `pro|agency`. The client calls it from `app/guide/page.tsx:573` and `app/payment/success/page.tsx:142`, and the server trusts the client to have paid. `userEmail` from the body is also written into the guide without checks (`template-processor.ts:436-438`).
- **Scenario:** `curl -XPOST /api/generate-styleguide -d '{"brandDetails":{"name":"x","brandDetailsDescription":"y","traits":["Warm"]}}'` returns a full paid guide. Run in a loop, each request fans out to 4-5 parallel chains, which can reach about 9 OpenAI calls for the rules chain alone (see AI-13). There are no length limits (AI-15), so cost grows with whatever body size the caller sends.
- **Fix:** Require an authenticated user. Check entitlement on the server (tier or a paid one-off purchase record keyed to the Stripe session) before calling any generation. Derive `userEmail` from the session, never from the body. Add per-user/IP rate limiting (for example Upstash or a Supabase counter table). Put the shared check in a `requireEntitlement(req)` helper used by `generate-styleguide`, `preview` (paid branch) and `expand-style-guide`.
- **Test:** route-level vitest with `@/lib/supabase-server` and `@/lib/template-processor` mocked:
  ```ts
  vi.mock("@/lib/supabase-server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))
  const render = vi.fn(); vi.mock("@/lib/template-processor", () => ({ renderStyleGuideTemplate: render, renderFullGuideFromPreview: render }))
  it("rejects anonymous callers without generating", async () => {
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ brandDetails: { name: "a", brandDetailsDescription: "b" } }) }))
    expect(res.status).toBe(401); expect(render).not.toHaveBeenCalled()
  })
  it("rejects starter tier with 403", ...)
  it("ignores body.userEmail and uses session email", ...)
  ```

### AI-2 - HIGH - SSRF in `/api/extract-website`: private, loopback and metadata hosts allowed; redirects and attacker-chosen subpage links followed
- **Where:** `lib/url-validation.ts:9-49` (only `hostname === 'localhost'` is blocked, line 29). `lib/cheerio-site-scraper.ts:20` (default `redirect: 'follow'`), `:43-50` (any `href` matching `/about|company|team/` is collected, including absolute off-site URLs), `:57` (fetched with no validation). `app/api/extract-website/route.ts:65` has no auth.
- **Reproduced** (`exp/ssrf.ts`, `exp/cheerio.ts`):
  ```
  "localhost."                -> true https://localhost./
  "127.0.0.1"                 -> true
  "http://169.254.169.254/latest/meta-data/" -> true
  "2130706433" / "0x7f000001" -> true https://127.0.0.1/
  "[::1]" "0.0.0.0" "10.0.0.5" "metadata.google.internal" "intranet" -> true
  REDIRECT: public page 302 -> 127.0.0.1/latest/meta-data/  => "SECRET-INTERNAL-TOKEN path=/latest/meta-data/"
  SUBPAGE: public page <a href="http://127.0.0.1:PORT/about"> => "...[Subpage: http://127.0.0.1:.../about] SECRET-INTERNAL-TOKEN"
  ```
- **Scenario:** An attacker hosts a page with a tiny homepage and `<a href="http://10.0.0.1/admin/about">`, or a 302 to an internal address. The scraped internal text goes into the first 1500 characters of `homepageContext` (route `:252`), then into the prompt. Prompt-injection text on the attacker's page ("include the subpage text verbatim in the description") brings it back in `brandDetailsDescription`. Validation also accepts single-label hosts (`intranet`) and DNS names that resolve to private IPs (DNS rebinding). Impact depends on the network: Vercel Lambdas have no EC2-style IMDS, but any self-hosted or VPC deployment is exposed.
- **Fix:** Add `assertPublicHttpUrl(url)`. It should: allow `http:`/`https:` only and ports 80/443; reject IP literals in private, loopback, link-local, CGNAT, multicast and ULA ranges, plus `0.0.0.0` and `::`; reject single-label hosts and `*.internal`/`*.local`; resolve DNS (`dns.promises.lookup(host, {all:true})`) and reject if any address is private. Fetch with `redirect: 'manual'` and re-validate every `Location` (max 3 hops). Run the same check on every subpage URL, and only follow subpage links on the same registrable domain. Cap the response body (stream and stop at 1-2 MB) and require `content-type: text/html`.
- **Test:**
  ```ts
  describe("assertPublicHttpUrl", () => {
    it.each(["http://127.0.0.1","https://localhost.","https://2130706433","https://[::1]","http://169.254.169.254","https://10.1.2.3","https://intranet","https://metadata.google.internal","ftp://x.com","https://x.com:6379"])("rejects %s", async u => { await expect(assertPublicHttpUrl(u, { lookup: fakeLookup })).rejects.toThrow() })
    it("rejects public hostname resolving to private IP", async () => { await expect(assertPublicHttpUrl("https://evil.test", { lookup: async () => [{ address: "10.0.0.1", family: 4 }] })).rejects.toThrow() })
    it("accepts https://acme.com resolving to 93.184.216.34", ...)
  })
  // cheerio-site-scraper.test.ts style: start a local "public" server with injectable validator that treats 127.0.0.1:PORT_A as public and 127.0.0.1:PORT_B as private
  it("does not follow a redirect to a private host", ...)
  it("does not fetch an off-domain about link", ...)
  ```

### AI-3 - HIGH - Deprecated `/api/ai-assist` is still deployed and is an unauthenticated OpenAI proxy
- **Where:** `app/api/ai-assist/route.ts:185-332`. No auth. `text` is capped at 5000 characters (`:220`), but `context` is never length-checked (`:199-203`) and goes into the prompt as-is (`:145`). The file is marked `// DEPRECATED` and grep finds no caller in the repo. The build output includes it (`.next/server/app/api/ai-assist`).
- **Scenario:** Anyone can POST `{text:"x", context:"<1 MB of tokens>"}` repeatedly and run up the OpenAI bill against `gpt-5.2`. `rewrite-section` (`app/api/rewrite-section/route.ts`) is also deprecated with no callers. It is authenticated but has no length limits on `currentContent`, `instruction` or `selectedText`.
- **Fix:** Delete both routes (SIMP-1). If kept, add auth, a tier check and length caps on every field.
- **Test:** `it("POST /api/ai-assist is gone", () => expect(existsSync("app/api/ai-assist/route.ts")).toBe(false))`. Or, if kept: `it("401 without session")`, `it("400 when context > 2000 chars")`.

### AI-4 - HIGH - `/api/ai/command` lets the client pick any OpenAI model and has no size limits
- **Where:** `app/api/ai/command/route.ts:57-78`: `const modelId = model || 'gpt-5-mini'` comes straight from the request body. The client never sends `model` (`components/editor/plugins/ai-kit.tsx:26` `body: {}`), so this is pure attack surface. There is no tier check (any signed-in free user). There are no limits on `messages` length or count, or on `ctx.children` size: `formatTextFromMessages` (`utils.ts:167-188`) uses the whole history because no caller passes `limit` (`prompt/getChooseToolPrompt.ts:137` etc.).
- **Scenario:** A free-tier user sends `{"model":"o1-pro", "messages":[...200 long messages...]}`. Each request then makes 2-3 model calls (tool choice via `generateObject` and `streamText`, plus `streamObject` for the comment/table tools) on the most expensive model, with the whole history in context.
- **Fix:** Ignore `body.model` or check it against a server allow-list (`{"gpt-5-mini"}`). Cap `messages.length` (for example the last 10), cap total characters, pass `limit` to `formatTextFromMessages`, and reject `ctx.children` JSON over N KB. Consider requiring a paid tier, as in AI-1.
- **Test:**
  ```ts
  vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => (id: string) => { seen.push(id); return fakeModel } }))
  it("ignores client-supplied model", async () => { await POST(req({ model: "o1-pro", messages: [userMsg("hi")] })); expect(seen).toEqual(["gpt-5-mini"]) })
  it("413 when messages exceed limit", ...)
  // pure: formatTextFromMessages(msgs, { limit: 3 }) returns only the last 3 lines
  ```

### AI-5 - HIGH - `formatMarkdownContent` corrupts generated Style Rules (times, URLs, headings, ellipses)
- **Where:** `lib/template-processor.ts:123-221`, applied to rules at `:531` and `:611`. Specific steps: `:140` (Step 1.5: any line starting with a number becomes `## H2`), `:206` (Step 8 `\s+([,.!?:;])` strips whitespace, including newlines, before punctuation), `:218` (Step 10 `:(\S)` becomes `: $1`).
- **Reproduced** (`exp/fmt.ts`, using the real `renderRulesMarkdown` output):
  ```
  RAW:       Write times as 10:00 am ...          ✅ Join us at 10:00 am GMT.
  FORMATTED: Write times as 10: 00 am ...         ✅ *Join us at 10: 00 am GMT*.
  RAW:       Link to https://acme.com in full.
  FORMATTED: Link to https: //acme.com in full.
  RAW:       ### 2. Sentence Length\n20 words or fewer keeps every sentence easy to scan.
  FORMATTED: ### 2. Sentence Length\n\n## 20 words or fewer keeps every sentence easy to scan.
  RAW:       ✅ Wait... what?   ❌ Wait . . . what?
  FORMATTED: ✅ *Wait... what*? ❌ *Wait... what*?      <- good and bad examples now identical
  ```
- **Impact:** Step 10 undoes the "10: 00" to "10:00" repair in `rules-renderer.ts:12` and breaks the prompt's own instruction (`openai.ts:514`). Every URL and time in rules is mangled. A description starting with a digit becomes a bogus H2, which `parseStyleGuideContent` treats as a new top-level section: the sidebar gets an extra entry with `minTier:'starter'`, and Style Rules is split in two. That also breaks `replaceSectionInMarkdown` boundaries on the next expand or edit. The Ellipses/Quotation/Serial-comma "bad" examples get "fixed" by Step 8.
- **Fix:** Rules already come out as deterministic markdown from `renderRulesMarkdown`, so stop running `formatMarkdownContent` on them. Use the renderer output as-is, wrapping examples in italics there if needed. For trait markdown, keep only the whitespace/heading normalisation, and drop Steps 1.5, 8 and 10 (or apply them only outside example lines). Export the function from a pure module (`lib/markdown-format.ts`) so it can be tested.
- **Test:**
  ```ts
  it("preserves times and URLs", () => { const out = formatMarkdownContent(renderRulesMarkdown([rule({ description: "Use 10:00 am. See https://a.com" })])); expect(out).toContain("10:00 am"); expect(out).toContain("https://a.com") })
  it("never introduces H2 headings", () => { const out = formatMarkdownContent(renderRulesMarkdown([rule({ description: "20 words max per sentence." })])); expect(out).not.toMatch(/^## /m) })
  it("keeps the bad example distinct from the good example", ...)
  it("parseStyleGuideContent sees exactly one style-rules section after formatting 25 rules", ...)
  ```

### AI-6 - HIGH - Failed section generation is saved as success; the guide then cannot be expanded again
- **Where:** `lib/template-processor.ts:609-620` substitutes `"_Could not generate rules._"`, `"_Could not generate before/after examples._"` or `"_Could not generate word list._"` when a section fails. `app/api/expand-style-guide/route.ts:77-88` only checks for the `_Unlock to see ..._` placeholders, then saves (`:90-97`) and returns `success: true`. On the next attempt `hasPlaceholders` is false (`:45-52`), so the route returns `400 "Guide already has full content"`. `generate-styleguide` likewise returns `success: true` with the failure text (`route.ts:79-100`).
- **Scenario:** The word-list JSON is truncated or malformed (common, see AI-11). `generateWordList` returns `{success:false}` with no retry. A paying Pro user's guide is permanently saved with `_Could not generate word list._`, and the "Expand" action now refuses.
- **Fix:** Have `renderFullGuideFromPreview` / `renderStyleGuideTemplate` return `{ markdown, failedSections: string[] }`. In expand, retry the failed sections once, and if they still fail, save nothing and return 502 with the section names. Or keep the `_Unlock..._` placeholder for failed sections so a retry is possible. In generate-styleguide, surface `failedSections` to the client.
- **Test:**
  ```ts
  vi.mock("./openai", () => ({ generateStyleRules: async () => ({ success: true, content: RULES_MD }), generateBeforeAfterSamples: async () => ok("x"), generateWordList: async () => ({ success: false, error: "bad json" }) }))
  it("reports failed sections instead of embedding failure text", async () => {
    const r = await renderFullGuideFromPreview({ previewContent: PREVIEW_WITH_PLACEHOLDERS, brandDetails })
    expect(r.failedSections).toEqual(["word-list"]); expect(r.markdown).toContain("_Unlock to see Word List._")
  })
  // route: expand returns 502 and does not call supabase.update when failedSections non-empty
  ```

### AI-7 - HIGH - Upgrade path drops all trait detail from the rules, examples and word-list prompts
- **Where:** `lib/template-processor.ts:595`: `previewContent.match(/## Brand Voice([\s\S]*?)(?=##|$)/)`. The lazy match stops at the first `##`, which is the `###` of the first trait heading (`### 1. Warm`).
- **Reproduced:** `BrandVoice capture: "\n\n"`, so `traitsContext` is reduced to `"Selected Traits: A, B, C"`.
- **Impact:** This is the main paid path. The client always sends `previewContent` from localStorage (`app/guide/page.tsx:563-578`, `payment/success/page.tsx:137-146`), and expand always uses it. Rules, Before/After and Word List are generated without the brand-specific trait descriptions the user saw in the preview, so the paid sections are generic.
- **Fix:** Use `getSectionContentFromMarkdown(previewContent, "brand-voice")` from content-parser (already exists, H1/H2-aware), or fix the regex to `/^## Brand Voice\s*\n([\s\S]*?)(?=^## |\Z)/m`.
- **Test:**
  ```ts
  it("extracts full brand-voice section including ### trait blocks", () => {
    const md = "## Brand Voice\n\n### 1. Warm\n\nWarm s.\n\n### 2. Direct\n\nD.\n\n## Style Rules\n\nx"
    expect(extractTraitsContext(md, ["Warm","Direct"])).toContain("### 2. Direct")
  })
  ```

### AI-8 - MEDIUM - `replaceSectionInMarkdown` replaces the wrong section when a skipped heading exists
- **Where:** `lib/content-parser.ts:233-268`. `sectionIndex` is an index into `sections` (`:254`), but it is used to index `matches` (`:262`). `parseStyleGuideContent` drops `## Content Guidelines` headings (`:149-151`), so the two arrays are out of step whenever such a heading exists (legacy guides; the comment says the section "was removed").
- **Reproduced:**
  ```
  input:  ## About X / ## Content Guidelines / ## Style Rules (_Unlock..._) / ## Before / After
  replaceSectionInMarkdown(md, "style-rules", "## Style Rules\n\nNEW RULES") =>
  ## About X / ## Style Rules NEW RULES / ## Style Rules _Unlock to see Style Rules._ / ## Before / After
  ```
  The Content Guidelines section is deleted, the placeholder stays, and the fallback in `template-processor.ts:629-636` is skipped because `merged !== beforeRules`. In expand, this ends in the 500 "Placeholders still present" error after paying for all the generation.
- **Fix:** Build one list of `{id, start, end}` spans in a single pass (shared helper `scanH1H2Headings`) and use it for both parse and replace. Skip deprecated sections only at render time, not in the index space.
- **Test:** the reproduction above as a unit test: `expect(out.match(/^## Style Rules/gm)).toHaveLength(1)`, `expect(out).toContain("## Content Guidelines")`, `expect(out).not.toContain("_Unlock to see Style Rules._")`.

### AI-9 - MEDIUM - LLM JSON handling: no JSON mode, no `finish_reason` check, and retries don't cover the common failure
- **Where:** `lib/openai.ts`.
  - `:122-139`: no `response_format` (`json_object`/`json_schema`) for `"json"` calls.
  - `:141`: `finish_reason === "length"` is never checked. GPT-5.x reasoning tokens count against `max_completion_tokens`, and budgets are tight (`generateAudienceSection` 450, `generateWordList` 600, `generateBeforeAfterSamples` 800 at `reasoning_effort:"low"`). A truncated markdown section (audience) is returned as success, cut off mid-sentence.
  - `:14-20` `validateJsonResponse` is a no-op and `:165` "Skip validation". Invalid JSON is returned as `success:true`, so the transport-level retry loop never retries it. `generateWordList` (`:706-752`), `generateBeforeAfterSamples` (`:402-422`) and `generateKeywords`/`generateTraitSuggestions` (callers in extract-website) fail on the first bad parse. Only `generateStyleRules` re-asks.
  - `cleanResponse` (`:47-103`) tries every prefix length with `JSON.parse`, which is O(n²) and blocks the event loop. Reproduced (`exp/clean.ts`): a 6 KB truncated array takes 86 ms, a 30 KB one 1220 ms, and the result still does not parse. Text before the JSON containing `[` defeats extraction: `'Sure! [see below]:\n["Warm"...]'` returns `"[see below]:\n[...]"`. The outer `catch` (`:89-99`) is unreachable because the inner try swallows everything.
- **Fix:** Add `generateJson<T>(prompt, zodSchema, opts)`. It uses `response_format: { type: "json_schema", strict: true }` (or `zodResponseFormat` from `openai/helpers/zod`), checks `finish_reason`, `safeParse`s with zod, and on a parse or schema failure retries once with a larger token budget. Replace `cleanResponse`'s quadratic loop with a single fence strip plus a linear bracket-matching extractor.
- **Test:**
  ```ts
  const create = vi.fn(); vi.mock("./langsmith-openai", () => ({ createTracedOpenAI: () => ({ chat: { completions: { create } } }) }))
  it("retries when JSON is invalid", async () => { create.mockResolvedValueOnce(resp("{bad")).mockResolvedValueOnce(resp('{"preferredTerms":[],"avoidTerms":["x"],"spellingUsage":[]}')); expect((await generateWordList(bd)).success).toBe(true); expect(create).toHaveBeenCalledTimes(2) })
  it("treats finish_reason=length as failure", ...)
  it("extractJson is linear: 200KB garbage completes < 50ms", ...)
  it("extractJson skips leading prose containing brackets", () => expect(extractJson('ok [see]:\n["A"]')).toEqual(["A"]))
  ```

### AI-10 - MEDIUM - `extract-website`: unguarded `JSON.parse` of keywords throws away a successful extraction
- **Where:** `app/api/extract-website/route.ts:336` (URL path, outside any inner try) and `:163` (description path, inside the outer try, which turns it into a 500 "Description processing failed"). Also `:292` and `:108` parse the main result with no shape validation (`parsed.name` might be an object).
- **Scenario:** The brand description call succeeds. The keywords call returns `{"keywords": ["a", "b"` (truncated at 800 tokens), and the user gets "Failed to extract brand information". All four LLM calls are wasted and the client shows an error, even though the description was valid.
- **Fix:** Wrap each auxiliary parse in `safeJson()` and fall back to `[]`. Validate the main payload with zod (`name: string`, `description: string`, `productsServices: string[]`). Better still, merge the 4 calls into one structured-output call (the TODO at `:112`, `:302`).
- **Test:** route test with `generateKeywords` mocked to `{success:true, content:'{"keywords":["a"'}` and `generateWithOpenAI` mocked to valid brand JSON, then `expect(res.status).toBe(200); expect(body.keywords).toEqual([])`.

### AI-11 - MEDIUM - Retry and timeout policy: immediate retries, 10-minute SDK timeouts, multiplicative nesting, no `maxDuration`
- **Where:**
  - `lib/openai.ts:117-189` retries with no delay (a 429 is retried immediately) and builds a new client each attempt (`:121`), which also prints 4 LangSmith log lines per attempt (`langsmith-openai.ts:27-38`).
  - `new OpenAI({ apiKey })` (`langsmith-openai.ts:22`) keeps SDK defaults: `timeout` 10 min and `maxRetries` 2.
  - `generateStyleRules` wraps another 3 attempts around it (`:519-551`), so 3 x 3 x 3 = 27 HTTP attempts worst case. Client `callAPI`/`fetchWithRetry` adds 3 more around the whole route (AI-12).
  - None of `generate-styleguide`, `preview`, `expand-style-guide` or `extract-website` exports `maxDuration` (grep only finds it in the export-pdf routes).
- **Scenario:** An OpenAI brownout makes the request hang for minutes and multiplies spend. The platform kills the function at its default limit with no clean error to the user, and the client retries the whole route.
- **Fix:** Create one shared client per module, `new OpenAI({ apiKey, timeout: 60_000, maxRetries: 2 })`, and drop the hand-rolled transport retry (keep only the content-validation retry from AI-9). Set a per-request `AbortSignal` deadline shared by all section calls. Export `maxDuration` on the generation routes, set to match that deadline.
- **Test:** with `vi.useFakeTimers()` and a mocked client that rejects with `{status:429}`: `expect(create).toHaveBeenCalledTimes(1)` (SDK-level retry only). `generateWithOpenAI` must honour `opts.signal` and reject with `AbortError` when it fires.

### AI-12 - MEDIUM - `fetchWithRetry` retries 4xx (contrary to its comment), retries 5xx with no backoff, and discards the caller's signal
- **Where:** `lib/api-utils.ts:401-449`.
  - `:423-425` throws for 4xx inside the same `try`. The `catch` at `:432-439` classifies it: "HTTP 401: Unauthorized" becomes `SESSION_EXPIRED`, 403 becomes `WEBSITE_BLOCKED`, 400/404 become `UNKNOWN_ERROR`/`WEBSITE_NOT_FOUND`, and all of these are in `retryableErrors` (`:333-350`).
  - `:428-430`: for 5xx with attempts left, the loop falls through with no delay.
  - `:414` overwrites `options.signal`.
- **Reproduced** (`exp/retry.ts`, `delayMs: 50`):
  ```
  400 calls: 3   401 calls: 3   403 calls: 3   404 calls: 3
  500 calls: 3 at ms: 0,0,0   (no backoff)
  timeout -> WEBSITE_TIMEOUT (retryable)
  ```
- **Impact:** `payment/success/page.tsx:142` uses `callAPI("/api/generate-styleguide")`. On a 5xx or a 5-minute timeout, the entire multi-call generation is re-run up to 3 times back to back, and the user can wait up to 15 minutes.
- **Fix:** Decide retryability from the HTTP status (retry only 408/429/502/503/504 and network `TypeError`), never from message text. Back off on every retry. Combine signals with `AbortSignal.any([options.signal, AbortSignal.timeout(ms)])`. Don't retry non-idempotent generation POSTs, or send an idempotency key the server honours.
- **Test:** the reproduction above as a unit test with `globalThis.fetch = vi.fn()` and fake timers: `expect(fetch).toHaveBeenCalledTimes(1)` for 400/401/403/404, `3` for 503 with delays `[1000, 2000]`, and an aborted caller signal rejects immediately.

### AI-13 - MEDIUM - No server-side input validation or size limits on generation inputs
- **Where:**
  - `app/api/generate-styleguide/route.ts:6-24` and `app/api/preview/route.ts:6-19` only check that `name` and `brandDetailsDescription` are non-empty, and they call `.trim()` on values whose type was never checked: a non-string `name` throws a TypeError, which surfaces as a 500.
  - `extract-website/route.ts:87-90` puts `body.description` in the prompt with no length limit (the 200-character limit is client-only, `lib/input-utils.ts:137`). `body.url.trim()` (`:218`) throws on a non-string.
  - `traits` arrays are unbounded (`openai.ts:303-312` makes one call for all of them), as are keyword item lengths and `previewContent`.
  - The intended limits exist but are dead code: `template-processor.ts:281-308` (name ≤ 50, description ≤ 2500, audience ≤ 500).
- **Fix:** Define one shared zod schema `BrandDetailsInput` (`name` 1-80, description 1-2500, audience ≤ 500, traits ≤ 3 strings ≤ 40, keywords ≤ 25 strings ≤ 40, productsServices ≤ 20 strings ≤ 80, `previewContent` ≤ 60 KB, `url` ≤ 2048) and parse every route body with it. Reject bodies over 100 KB before `request.json()`.
- **Test:**
  ```ts
  it.each([{name:123}, {name:"x".repeat(81)}, {traits: Array(50).fill("a")}, {brandDetailsDescription:"x".repeat(2501)}])("rejects %o", b => expect(BrandDetailsInput.safeParse({...valid, ...b}).success).toBe(false))
  // route: non-string name -> 400 not 500
  ```

### AI-14 - MEDIUM - Prompt-injection exposure from scraped and user content
- **Where:**
  - `extract-website/route.ts:252,262` puts raw homepage text into the prompt with no delimiters and no "treat as data" instruction.
  - `cheerio-site-scraper.ts:37` uses `$("main").text() || $("body").text()`, which includes `<script>`/`<style>` bodies. Reproduced: `"T\nwindow.__CONFIG={\"apiKey\":\"abc\"};function x(){}Visible copy.a{color:red}"`.
  - User fields (`name`, description, audience, keywords, `previewTraits`) go into every section prompt in `openai.ts` the same way (for example `:247-256`, `:489-517`).
  - Client-supplied `brandDetails.previewTraits` (`template-processor.ts:481-489`) is inserted verbatim into the guide and into `traitsContext` (4000 characters) for 3 more prompts.
- **Impact:** Mostly self-inflicted (the user controls the URL and fields). But together with AI-2 it is an exfiltration channel, and inline JS/CSS wastes the 1500-character context budget.
- **Fix:** Strip `script, style, noscript, svg, template` before `.text()`. Wrap untrusted text in tagged blocks (`<website_content>...</website_content>`) and add a system instruction to ignore instructions inside them. Use structured outputs so injected text can only land in typed string fields. Generate `previewTraits` on the server (or re-validate them) instead of trusting the client.
- **Test:** `it("excludes script/style text", ...)` in `cheerio-site-scraper.test.ts` with the page above, `expect(out).not.toContain("apiKey")`. Prompt-builder unit: `buildExtractionPrompt({homepage:"IGNORE PREVIOUS"})` wraps it inside `<website_content>`.

### AI-15 - MEDIUM - Cheerio scraper: a malformed about-link throws away the whole homepage; no status, content-type or size checks
- **Where:** `lib/cheerio-site-scraper.ts:47`. `new URL(u, url)` runs inside `$("a").each` with no try/catch. `:31` reads the full body with no size cap and checks neither `res.ok` nor `content-type`.
- **Reproduced:** a homepage containing `<a href="//[about">About</a>` makes the call throw `BADLINK threw: Invalid URL`. extract-website catches it and falls back to "model knowledge", dropping perfectly good homepage text. A 404/500 error page or a large binary download is treated as homepage content.
- **Fix:** Wrap the URL construction in try/catch and skip bad links. Return early when `!res.ok` or the content type is not HTML. Read the stream up to 1 MB.
- **Test (add to existing file):** `it("ignores malformed hrefs and still returns homepage content")`, `it("returns '' for a 404")`, `it("stops reading after 1MB")` (the server streams 5 MB; assert it resolves and the output is ≤ 7000 characters).

### AI-16 - MEDIUM - AI SDK version skew is the cause of the 12 `ai/command` type errors
- **Where:** `package.json`: `ai@^5.0.28` (installed 5.0.28) next to `@ai-sdk/react@3.0.88`, which depends on `ai@6.0.86` (`node_modules/@ai-sdk/react/package.json`). Both `ai@5.0.28` and `ai@6.0.86` are in `.pnpm`. The server route, `DefaultChatTransport` and the `UIMessage` type in `components/editor/use-chat.ts` use v5, while `useChat` is v6. `ChatMessage = UIMessage<{}, MessageDataPart>` declares only `toolName`, yet the route writes `data-comment`/`data-table` parts with `id`. That is the cause of the tsc errors at `route.ts:118,123,224,231,271,278`. The errors at `:71-72` (selection/value typed `unknown`) and `:201-203,253-255` (overloads) come from the same untyped `ctx` and SDK mismatch.
- **Impact:** Client/server stream-protocol drift between major versions, and type checking in this route is effectively off (`next.config.js` sets `ignoreBuildErrors: true`).
- **Fix:** Align on one major (`ai@6` + `@ai-sdk/openai@3`, or pin `@ai-sdk/react@2` for v5). Extend `MessageDataPart` with `comment` and `table` payload types. Validate `ctx` with zod (`children: z.array(z.any()).max(500)`, `selection: RangeSchema.nullable()`).
- **Test:** a `tsc --noEmit` gate in CI scoped to `app/api/ai/command/**` (expect 0 errors). Unit: `getChooseToolPrompt({isSelecting:false, messages:[...]})` snapshot. Route test: a mocked model returns `'comment'` and the stream contains a `data-comment` part.

### AI-17 - MEDIUM - DOCX export writes invalid numbering XML and outputs markdown tables as raw pipe text
- **Where:** `lib/file-generator.ts:281` uses `numbering: { reference: "default-numbering" }`, but the `Document` (`:92-97`) defines no `numbering.config`. Tables (the Word List is 100% tables, `openai.ts:715-747`) fall through to plain paragraphs (`:286-293`).
- **Reproduced** (`exp/docx2.ts`): `document.xml` contains `<w:numId w:val="{default-numbering-0}"/>`. That placeholder was never resolved and is not a valid integer `numId`, so Word may report "unreadable content" or drop the numbering. Table rows come out as literal `| Use | Instead of |` and `|-----|------------|` paragraphs.
- **Fix:** Add `numbering: { config: [{ reference: "default-numbering", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }] }] }`, and parse contiguous `|` lines into `docx.Table`. Or reuse `@platejs/docx`/remark to serialise, instead of a hand-written parser.
- **Test:** `generateFile("docx","1. a\n2. b","X")`, unzip with JSZip, `expect(doc).toMatch(/<w:numId w:val="\d+"\/>/)`. And `generateFile("docx", "| A | B |\n|---|---|\n| c | d |")` makes `document.xml` contain `<w:tbl>` and not `|---|`.

### AI-18 - LOW - `String.replace` with user/AI text as the replacement string interprets `$` patterns
- **Where:** `lib/template-processor.ts:440-455, 507-546` (`.replace(/{{x}}/g, value)`), and `:632-655` fallbacks.
- **Reproduced:** brand `"Ca$$h"` becomes `"Ca$h"`. The description `"save $$ and keep $' safe"` becomes `"save $ and keep \n safe"` (`$'` inserts the rest of the template). AI copy like "Save $$$ today" in Before/After loses characters.
- **Fix:** Use a function replacer, `.replace(re, () => value)`, or a single `fillTemplate(template, vars)` helper.
- **Test:** `expect(fillTemplate("{{a}}", { a: "$$ $& $' $`" })).toBe("$$ $& $' $`")`.

### AI-19 - LOW - `validateRules` category matching is brittle, and a `null` element throws
- **Where:** `lib/rules-schema.ts:97-99` uses an exact, case-sensitive `includes`. The uniqueness check at `:139` is case-insensitive and trimmed, which is inconsistent. `:106` dereferences `rule.category` on `null`.
- **Reproduced:** `["Capitalization" (US spelling), "Emojis ", "Active vs Passive Voice"]` gives `valid.length = 0`, and `validateRules([null])` throws "Cannot read properties of null". When 6+ of 25 rules miss the strict match, `generateStyleRules` (`openai.ts:544`) pays for up to 9 more calls.
- **Fix:** Normalise (trim, lowercase, strip punctuation, map `ization` to `isation`) against a lookup map back to the canonical name. Skip non-objects. Check `typeof` for string fields.
- **Test:** `it.each(["capitalization"," Emojis ","Active vs Passive Voice"])("accepts %s and canonicalises", c => expect(validateRules([rule({category:c})]).valid[0].category).toBe(canonical))`, plus `it("skips null/strings")`.

### AI-20 - LOW - The upgrade path never puts the user's email in the "Questions?" section, and drops `productsServices`
- **Where:** `lib/template-processor.ts:660` calls `replaceSectionInMarkdown(merged, "questions", ...)`, but the section id is `contact` (`content-parser.ts:91-96`). Reproduced: `changed? false  ids: about,brand-voice,style-rules,contact`. Separately, `validatedDetails` at `:581-590` omits `productsServices`, unlike the full path at `:465-467`, so upgraded guides get less specific rules, examples and word lists. `contactFooter` (`:425-428`) is computed and never used in `renderStyleGuideTemplate`.
- **Fix:** Use `"contact"`, and make one `toValidatedDetails(brandDetails)` helper shared by both paths.
- **Test:** `renderFullGuideFromPreview({previewContent: PREVIEW, brandDetails, userEmail:"a@b.co"})` returns markdown containing `"Contact a@b.co"`. Spy on `generateWordList` and check `bd.productsServices` is passed.

### AI-21 - LOW - Client input detection misclassifies descriptions as URLs; client and server URL validators disagree
- **Where:** `lib/input-utils.ts:33-41`. Pattern `/\.[a-z]{2,}([\/\?]|$)/i` matches any text ending in `.js`, `.co`, `.uk`, and so on.
- **Reproduced:** `"We build tools for node.js"`, `"Acme is a bakery in London. Visit acme.co"` and `"...in Leeds.uk"` all give `url false "Enter a valid URL"`, so the user cannot proceed. The client requires a dot in the hostname (`:95`); the server `validateUrl` does not (`intranet` passes).
- **Fix:** Treat input as a URL only if it has no whitespace and parses as a URL with a dotted host. Share one `parseUserUrl` between client and server, with the SSRF checks from AI-2 on the server.
- **Test:** `it.each(["We build tools for node.js","Visit acme.co today, we bake bread"])("is description: %s", s => expect(detectInputType(s).inputType).toBe("description"))`, `it.each(["acme.com","https://acme.co.uk/about","www.x.io"])("is url: %s", ...)`.

### AI-22 - LOW - Type errors in scope (tsc baseline)
- `app/api/extract-website/route.ts:154,155,162,163,329,330,335,336`: `.catch(err => ({success:false, error}))` widens the union so `.content` is missing. Fix: export `GenerationResult` from `lib/openai.ts` and use `.catch((err): GenerationResult => ...)`. `:186,208,359`: `Logger.error(msg, unknown)`. Fix: `toError(e)`.
- `lib/logger.ts:22`: `formatError` returns `object`, but `LogEntry.error` is typed `Error`. Fix: `error?: SerializedError`.
- `app/api/generate-styleguide/route.ts:3`: imports `captureServerError` from the deleted `@/lib/posthog` (removed in #20, see `docs/RELEASE-NOTES-2026-03.md:31`). The import is never used, so SWC drops it and the build succeeds (the `.next/server/app/api/generate-styleguide` output exists). Any future use would break the build. Fix: delete the import.
- `lib/firecrawl-site-scraper.ts:170,191`: Firecrawl v4 `formats` typing. The file is dead (SIMP-3); delete it rather than fixing.
- `app/api/ai/command/route.ts`: 12 errors, see AI-16.
- **Test:** a scoped `tsc -p tsconfig.json --noEmit` diff gate: none of these file paths may appear in output.

### AI-23 - LOW - PII and noise in production logs
- **Where:** `generate-styleguide/route.ts:36,53` `console.log` the whole request body (`userEmail`, the full `previewContent`, brand details) on every call. `openai.ts:150-158` prints a token-usage banner on every call. `langsmith-openai.ts:27-38` prints 4 lines per client creation (one per attempt). `extract-website/route.ts:178` logs model output with `Logger.info`.
- **Fix:** Log ids and lengths only, and put details behind `Logger.debug`. Create the client once.
- **Test:** `vi.spyOn(console,"log")`; after POSTing a body with `userEmail:"a@b.co"`, no logged argument contains `"a@b.co"`.

### AI-24 - LOW - `expand-style-guide` has no concurrency guard
- **Where:** `app/api/expand-style-guide/route.ts:44-97`: read, generate (30-60 s), unconditional update.
- **Scenario:** A double-click or two tabs run two full generations (double spend) and the last write wins. A user edit saved during generation is overwritten by the expansion.
- **Fix:** Add an optimistic concurrency check: `.update(...).eq("id", guideId).eq("updated_at", guide.updated_at)` (select `updated_at` too), and return 409 if 0 rows are updated. Optionally add an `expanding_at` lock column.
- **Test:** mock supabase where the update returns `{count:0}`, expect a 409 response.

### AI-25 - LOW - Trait suggestions are not constrained to the allowed list
- **Where:** `lib/openai.ts:826-829`. The allowed list is `Assertive, Witty, Direct, Inspiring, Warm, Inclusive, Playful, Supportive, Refined`, but the example output is `["Warm", "Professional", "Inspiring"]`, and "Professional" is not in the list. `extract-website/route.ts:181-182,354-355` accepts any array, and the client auto-selects the first 3 (`components/CreateGuideModal.tsx:250`, `hooks/use-extraction.ts:455`).
- **Fix:** Use an example drawn only from allowed traits, then filter case-insensitively against `Object.keys(TRAITS)` and canonicalise the case. Use a JSON-schema enum.
- **Test:** `parseTraitSuggestions('["warm","Professional","Witty"]')` gives `["Warm","Witty"]`.

### AI-26 - LOW - The brand-name hint taken from the URL uses the subdomain
- **Where:** `extract-website/route.ts:240`: `hostname.replace('www.','').split('.')[0]`.
- **Reproduced:** `shop.acme.com` gives `shop`, `news.bbc.co.uk` gives `news`, `awww.example.com` gives `aexample`. This value is the prompt's headline "Write a brand description for shop".
- **Fix:** Strip only a leading `www.`, and take the registrable-domain label (a tiny public-suffix helper, or the second-to-last label with a `co.uk`-style exception list).
- **Test:** `it.each([["shop.acme.com","acme"],["www.bbc.co.uk","bbc"]])("brandHintFromHost(%s) = %s", ...)`.

### AI-27 - LOW - `cleanResponse` strips code fences from markdown output but leaves the language tag
- **Where:** `lib/openai.ts:49`. Only `json` and `markdown` tags are removed.
- **Reproduced:** `"Use this:\n```js\nconst a = 1\n```\nDone"` becomes `"Use this:\njs\nconst a = 1\nDone"`.
- **Fix:** Only unwrap a single fence that encloses the whole response (`/^```[\w-]*\n([\s\S]*)\n```$/`). Leave inner fences alone.
- **Test:** `expect(stripOuterFence("```markdown\n# A\n```")).toBe("# A")`, and `expect(stripOuterFence("x\n```js\ny\n```")).toBe("x\n```js\ny\n```")`.

### AI-28 - LOW - Section-eyebrow matching is too broad
- **Where:** `lib/guide-styles.ts:148`: `lower.includes("about")` is checked first, so any custom heading containing "about" (for example "What we care about") gets the eyebrow "BRAND OVERVIEW".
- **Fix:** Reuse `getSectionIdFromHeading` from content-parser and map ids to eyebrows and descriptions. That also removes the third copy of the heading regexes.
- **Test:** `expect(getSectionEyebrow("What we care about")).toBeNull()`, `expect(getSectionEyebrow("About Acme")).toBe("BRAND OVERVIEW")`.

---

## Simplifications and dead code

Evidence: `grep -rnw <symbol> --include=*.ts --include=*.tsx --include=*.js --include=*.mjs --exclude-dir=node_modules --exclude-dir=.next .` unless noted.

- **SIMP-1 Delete the deprecated routes `app/api/ai-assist/route.ts` and `app/api/rewrite-section/route.ts`.** Both are headed `// DEPRECATED: Replaced by @platejs/ai + /api/ai/command`. grep `ai-assist|rewrite-section|AIAssistAction` outside the route files returns nothing. This also fixes AI-3.
- **SIMP-2 Delete `app/api/page.tsx` (public "ApiTestPage" at `/api`).** It is a debug UI that drives `extract-website` and `generate-styleguide`, has its own copy of `getAbsoluteUrl`, and is not linked from anywhere (grep `"/api"` href shows no links).
- **SIMP-3 Delete `lib/firecrawl-site-scraper.ts` (353 lines).** `scrapeSiteForExtraction` and `scrapeSiteWithJsonExtraction` are only imported, never called (`app/api/extract-website/route.ts:5`). This removes 2 tsc errors and lets you drop the `@mendable/firecrawl-js` dependency (see SIMP-4).
- **SIMP-4 Delete `lib/firecrawl.js` (290 lines) and `lib/blog-prompts.js` (263 lines), plus `lib/prompts/system-prompt.md`, `outline-instructions.md` and `article-instructions.md`.** No importers: grep for `firecrawl.js|searchBrief|blog-prompts|getBlogOutlinePrompt` matches only the files themselves. Their consumer `scripts/generate-blog-posts.js` no longer exists, and the `package.json` scripts `generate-blog*`, `convert-search-terms`, `update-post-images`, `update-blog-images`, `test-outline`, `test:style-guide-gen`, `generate-logos`, `generate-favicons`, `generate-og-image` and `generate-preview-pdf` point at missing files (`ls scripts/` shows none of them).
- **SIMP-5 Delete `lib/prompts/aistyleguide-style-guide.md`.** It is referenced only in `docs/REBRAND-TONEOFVOICE.md:218`, by no code.
- **SIMP-6 Delete `lib/url-utils.ts`.** `getAbsoluteUrl` has no importers (the only same-name symbol is a local function in `app/api/page.tsx`).
- **SIMP-7 Delete `lib/markdown-joiner-transform.ts` (239 lines).** No importers (grep `markdownJoinerTransform|MarkdownJoiner|markdown-joiner-transform` matches only itself). The `ai/command` route never sets `experimental_transform`.
- **SIMP-8 Dead code in `lib/openai.ts` (about 250 of 839 lines).** Each of these has 0 references outside its own definition:
  - `validateJsonResponse` (`:14-20`) and `validateMarkdownResponse` (`:22-45`).
  - `predefinedTraitToMarkdown` (`:198-213`), the only user of the `TRAITS` import. The imports `MixedTrait`, `isPredefinedTrait` and `isCustomTrait` are unused.
  - `generateCustomTraitDescription` (`:216-235`), used only by the dead `generateBrandVoiceTraitsPreview` (`:327-359`, no importers).
  - `generateContentGuidelines` (`:610-642`), `generateBrandSummary` (`:807-810`) and `extractBrandName` (`:813-816`).
  - The commented-out `generateStyleGuideRules` (`:429-464`) and the unreachable outer `catch` in `cleanResponse` (`:89-99`).
  - The redundant check `model === "gpt-5.2" || model.startsWith("gpt-5")` (`:131`).
- **SIMP-9 Dead code in `lib/template-processor.ts` (about 200 of 664 lines).** The following have 0 callers (grep `-cw` returns only their definition, or only internal mutual references):
  - `PREVIEW_CONFIG` (`:13-16`), `logGenerationMetrics` and `withRetry` (`:19-67`).
  - `validateMarkdownContent` (`:224-278`), `validateBrandDetails` (`:281-308`), `formatDate` (`:317-323`).
  - The `contactFooter` local in `renderStyleGuideTemplate` (`:425-428`).
  - `prepareMarkdownContent` (`:311-314`) is an identity function. Inline it.
  - The HTTP fallback in `loadTemplate` (`:88-104`) is unnecessary: the build traces `templates/style_guide_template.md` into every route that uses it (`.next/server/app/api/*/route.js.nft.json`). After that, `app/api/load-template/route.ts` has no caller (grep `load-template` only finds `template-processor.ts:94`) and can be deleted too.
- **SIMP-10 Dead exports in `lib/content-parser.ts`:** `mergeEditableIntoFullMarkdown` (`:274-288`), `getCopyForAIMarkdown` (`:219-225`), and `getSectionContentFromMarkdown` (only used by the latter, but reuse it for AI-7). The heading-scan regex `/^(#{1,2})\s+(.+)$/gm` is duplicated at `:123` and `:243`. Extract a single scanner (this also fixes AI-8).
- **SIMP-11 Dead in `lib/file-generator.ts`:**
  - `downloadFile` (`:355-366`) and `generateFileWithMimeType` (`:369-394`) have no importers. `components/ui/export-toolbar-button.tsx` has its own `downloadFile`.
  - The "keep emoji" replacements at `:313-321` (`💪`, `🏃`, `⚡`, `🎯`, `→`, `←`, `↑`, `↓`) each replace a character with itself.
  - `FileFormat` includes `"pdf"`, which `generateFile` always rejects (`:28`).
- **SIMP-12 Dead exports in `lib/guide-styles.ts`:** `EDITOR_BODY_CLASS`, `SECTION_H2_CLASS`, `SECTION_H2_STYLE` and `SECTION_H2_BAR_CLASS` have 0 external references. `SERIF_FONT_STYLE` is only used inside the file, so un-export it.
- **SIMP-13 Dead code in `app/api/ai/command/utils.ts`:** `inlineTag` (`:29-33`) and `list` (`:40-46`) have 0 references. The `ToolName` type is declared twice (`route.ts:32` and `components/editor/use-chat.ts:12`).
- **SIMP-14 Dead code in `app/api/extract-website/route.ts`:** the unused imports `scrapeSiteForExtraction` and `scrapeSiteWithJsonExtraction` (`:5`); the unused `BrandDetails`, `ProcessedBrandDetails` and `REQUIRED_FIELDS` (`:20-37`); the commented-out blocks (`:111-127`, `:301-312`). The description and URL branches duplicate about 80 lines (audience, keywords and traits post-processing). Extract `enrichBrandProfile(name, description, fallbackAudience)`.
- **SIMP-15 Consolidate the three copies of `validateBrandDetails`** (`generate-styleguide/route.ts:6`, `preview/route.ts:6`, `template-processor.ts:281`) into one zod schema (AI-13).
- **SIMP-16 One trait-name helper.** `(t) => typeof t === "string" ? t : t?.name` appears 6 times (`openai.ts:304,486`, `template-processor.ts:484,495,593`, and so on). Add `traitNames(traits)` to `lib/traits.ts`. The traits-context block is copy-pasted at `template-processor.ts:483-489` and `:494-500`.
- **SIMP-17 Two OpenAI stacks.** `lib/openai.ts` uses the `openai` v4 SDK with a hand-rolled retry and parsing. `ai/command` uses the AI SDK (`@ai-sdk/openai` + `generateObject`/`streamObject` with zod). Move `lib/openai.ts` onto `generateObject` with zod schemas to get structured output, validation and retries in one place (this fixes AI-9 and AI-11). Default models also differ (`gpt-5.2` vs `gpt-5-mini`). Centralise them in `lib/ai-models.ts`.
- **SIMP-18 Unused import in `lib/api-utils.ts:1`** (`import { OpenAI } from "openai"`). Pulling the server SDK into a client-imported module bloats the client bundle (`api-utils` is imported by `app/guide/page.tsx`, `CreateGuideModal.tsx` and others).
- **SIMP-19 Three markdown parsers and two code-fence strippers.** The content-parser section scanner, the `template-processor` regexes (Brand Voice extraction, fallbacks), the `file-generator` line parser and the `guide-styles` heading matchers each reimplement heading detection. Fence stripping exists in `openai.ts:49` and `template-processor.ts:231-233` (dead). Use the remark AST (`@platejs/markdown` is already installed) for section operations and DOCX.
- **SIMP-20 Merge duplicated URL validators:** `lib/url-validation.ts` (server) and `lib/input-utils.ts:73-122` (client), with different rules (AI-21).

---

## Unit-test (TDD) targets, ranked by value

Most of these are pure, but several are not exported today. Move them into small pure modules first (`lib/markdown-format.ts`, `lib/llm-json.ts`, `lib/brand-input.ts`, `lib/ssrf.ts`).

| # | Function (file) | Key behaviours to assert |
|---|---|---|
| 1 | `assertPublicHttpUrl` (new, `lib/ssrf.ts`) and `validateUrl` | Rejects loopback, private, link-local, metadata, decimal/hex IPs, `[::1]`, `localhost.`, single-label hosts and non-80/443 ports. Rejects a public name that resolves to a private IP (injected lookup). Accepts normal domains. |
| 2 | `fetchAndExtractWithCheerio` (existing test file) | Re-validates each redirect, skips off-domain and malformed subpage links, excludes script/style text, returns empty for non-2xx or non-HTML, caps body size. Existing timeout tests stay. |
| 3 | `formatMarkdownContent` (export) | Times, URLs and ratios unchanged. Never emits `## `. Bad examples keep deliberate spacing. Running it twice gives the same output. Combined with `parseStyleGuideContent`: exactly one `style-rules` section after 25 rules. |
| 4 | `parseStyleGuideContent` / `replaceSectionInMarkdown` / `insertCustomSection` / `getSectionIdFromHeading` | Ids map to configs. A legacy `Content Guidelines` heading doesn't shift replacement. Replacing the last section keeps the earlier ones. A missing id leaves the input unchanged. Custom sections are capped at 5 and inserted before Questions. Titles truncated at 60. |
| 5 | `extractTraitsContext` (new, from `template-processor.ts:592-601`) | Includes `###` trait blocks and stops at the next `## `. Capped at 4000 characters. Without a Brand Voice section returns only the trait names. |
| 6 | `cleanResponse` / `extractJson` (export) | Strips an outer fence only. Extracts JSON after prose containing brackets. Linear time on 200 KB. Truncated input gives a parse failure, not an exception. |
| 7 | `generateWithOpenAI` / `generateJson` (mock `createTracedOpenAI`) | Checks `finish_reason === "length"`. Retries on invalid JSON or a schema mismatch. No immediate retry on 429 (delegated to the SDK). Builds GPT-5 params (`max_completion_tokens`, `reasoning_effort`) vs legacy (`max_tokens`, `temperature`). |
| 8 | `validateRules` / `isValidRule` / `renderRulesMarkdown` / `sanitizeRuleText` | Canonical category normalisation, case-insensitive dedupe, null-safe. Renderer produces `### n. Title`, then the description, then the ✅/❌ lines. `sanitizeRuleText` fixes `10: 00`, adds a space before an opening quote, strips U+FFFD and zero-width characters. |
| 9 | Word-list and before/after JSON-to-markdown converters (extract from `openai.ts:706-752`, `:403-419`) | Table rows escape `|`. Empty arrays omit the subsection. String items in `"x not y"` form split correctly. At most 5 examples, with content-type fallbacks. |
| 10 | `fetchWithRetry` / `classifyError` / `createErrorDetails` (`lib/api-utils.ts`) | No retry on 4xx. Backoff on 5xx (fake timers). Caller's abort signal respected. Classification by status, not substring ("token" in "Invalid token" ≠ `OPENAI_TOKEN_LIMIT`). |
| 11 | `detectInputType` / `validateInput` (`lib/input-utils.ts`) | Descriptions containing `.js`/`.co` stay descriptions. URL forms are detected. 25 to 200 character bounds. `localhost` rejected. |
| 12 | `fillTemplate` (new) | All placeholders replaced. `$`-sequences preserved literally. Unknown placeholders left in place or reported. |
| 13 | `BrandDetailsInput` zod schema (new) | Length and type bounds from AI-13. Trims values. Coerces legacy `description` / `brandDetailsText` into `brandDetailsDescription`. |
| 14 | `flattenTargetAudience` (move out of route), `brandHintFromHost`, `parseTraitSuggestions` | Audience join order and empty parts. Subdomain handling. Allow-list filtering with case normalisation. |
| 15 | `parseMarkdownToDocxParagraphs` (via `generateFile` + JSZip) | Valid integer `numId`. Tables become `<w:tbl>`. Headings map to levels. `**bold**` and `*italic*` runs. |
| 16 | `ai/command/utils.ts`: `buildStructuredPrompt`, `formatTextFromMessages`, `getLastUserInstruction` | Section order and tags. History omitted when there is at most 1 message. `limit` honoured. Last user message chosen. Empty-text messages skipped. |
| 17 | `mergeExtractions` (only if Firecrawl is kept) | Longer description wins. Keyword union is case-insensitively deduped and capped at 25. |

Notes for implementers: `vitest.config.mts` uses `jsdom`. Node-only tests (http servers, `dns`, Buffer/JSZip) should start with `// @vitest-environment node`. The existing `lib/cheerio-site-scraper.test.ts` runs a throwaway `node:http` server, which is the right pattern for the scraper and SSRF tests.
