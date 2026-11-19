# 01 – Security, auth, payments, data access audit

Scope: `middleware.ts`, `lib/supabase*.ts`, `app/auth/**`, `app/actions.ts`, all of `app/api/**` (the AI routes were checked only for auth, rate limits and tier gating), `next.config.js`, `lib/email-service.ts`, `lib/url-validation.ts`, `supabase/migrations`.

This was a read-only audit: no repo files were changed. Every finding below comes from reading the code. Findings marked **[repro ✓]** were also confirmed with a vitest test that passed against the current code. Those tests are in
`scratchpad/audit/sectests/` (`sec.test.ts`, `sec2.test.ts`; 7/7 passing). To re-run them:

```
cd /home/user/toneofvoice-app && npx vitest run --root . --dir scratchpad/audit/sectests
```

Notes on testing routes with vitest:
- Put `// @vitest-environment node` at the top of route tests. The repo default is jsdom.
- When a test lives in the repo (for example `__tests__/api/*.test.ts`), use `vi.mock("@/lib/supabase-server")`, `vi.mock("@/lib/supabase-admin")` and `vi.mock("stripe")` as normal. My scratch tests sat outside the repo root, so they had to mock by absolute path. Inside the repo the `@/` alias works.
- The Stripe secret, mode and price IDs are read at **module load**. Set `process.env` and call `vi.resetModules()` *before* `await import(route)`.

## Severity summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 1 | SEC-1 |
| High | 9 | SEC-2 … SEC-10 |
| Medium | 6 | SEC-11 … SEC-16 |
| Low | 8 | SEC-17 … SEC-24 |

Checked and found OK: Stripe signature verification (raw body, secret required); cron keep-alive secret (constant-time compare, fails closed when `CRON_SECRET` is unset); IDOR on load, save and delete style guide (every query is scoped by `.eq("user_id", user.id)` using the user's JWT client); `create-portal-session` (uses the caller's own `stripe_customer_id`); `load-template` (name restricted to `^[a-zA-Z0-9_]+$`, no path traversal); the middleware matcher excludes `api/webhook`.

---

## CRITICAL

### SEC-1 — `/api/generate-styleguide` has no auth, which bypasses the paywall and allows unlimited paid OpenAI calls
- **File:** `app/api/generate-styleguide/route.ts:26-100` (the route never imports a Supabase client). The paywall is enforced only in the UI: `app/guide/page.tsx:573` and `app/payment/success/page.tsx:142`. `app/api/save-style-guide/route.ts:16-24,112-123` stores whatever `content_md` the client sends.
- **What's wrong:** This route generates the **full** guide (style rules, before/after examples, word list), which is the Pro/Agency deliverable. It skips the "_Unlock to see …_" placeholders that `expand-style-guide` gates on tier (`expand-style-guide/route.ts:39-41`). Anyone can call it with `curl -XPOST /api/generate-styleguide -d '{"brandDetails":{"name":"X","brandDetailsDescription":"…"}}'` and get the paid content without an account. A signed-in Starter user can then POST that content to `/api/save-style-guide`, which accepts arbitrary `content_md`, and keep a full guide forever. Each call also makes several long gpt-5.x requests, with no rate limit and no auth (see SEC-9).
- **Fix:**
  1. Require `supabase.auth.getUser()`, and require tier ∈ {pro, agency} **and** `subscription_status === "active"`. Alternatively, fold the logic into `expand-style-guide`, which already loads the guide server-side by `guideId` and ownership.
  2. Generate and persist server-side, keyed by `guideId`. Don't round-trip paid content through the client and back into `save-style-guide`.
  3. In `save-style-guide`, for Starter users, reject content that has no unlock placeholders, or re-apply the locks server-side.
  4. Add a per-user/IP rate limit (SEC-9).
- **Test:**
```ts
// @vitest-environment node
vi.mock("@/lib/supabase-server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }), MissingSupabaseConfigError: class extends Error {} }))
const renderStyleGuideTemplate = vi.fn()
vi.mock("@/lib/template-processor", () => ({ renderStyleGuideTemplate, renderFullGuideFromPreview: vi.fn() }))
it("401s anonymous callers and never calls OpenAI", async () => {
  const { POST } = await import("@/app/api/generate-styleguide/route")
  const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ brandDetails: { name: "A", brandDetailsDescription: "d" } }) }))
  expect(res.status).toBe(401); expect(renderStyleGuideTemplate).not.toHaveBeenCalled()
})
it("403s starter users", /* getUser -> user, profiles.single -> {subscription_tier:'starter'} */)
```

---

## HIGH

### SEC-2 — `/api/test-email` is an unauthenticated email relay from the company domain **[repro ✓]**
- **File:** `app/api/test-email/route.ts:8-27`
- **What's wrong:** Anyone can POST `{"email":"victim@x.com"}`. The route sends the "Thanks for your purchase!" email from `support@toneofvoice.app` in production (`lib/email-service.ts:120-122`). An attacker can loop it to spam any address, burn the Resend quota, and damage the domain's sending reputation (SPF/DKIM-signed mail landing in spam traps). The response also returns raw Resend error text.
- **Fix:** Delete the route. If it's still needed, gate it on `process.env.NODE_ENV !== "production"` **and** an admin secret header, and only send to an allowlist.
- **Test:** `sec.test.ts › "test-email sends to arbitrary address without auth"` passes today. Invert it: expect `404/401` and `sendThankYouEmail` not called.

### SEC-3 — `/api/post-to-webflow` lets anyone publish to the company Webflow CMS
- **File:** `app/api/post-to-webflow/route.js:4-63`
- **What's wrong:** There's no auth, no shared secret, and no Zapier signature check. Any POST with `title/slug/body` creates a Webflow CMS item with `isDraft:false` using the server's `WEBFLOW_TOKEN`, so attackers can plant spam or phishing posts on the marketing blog. The `400` response echoes the full request body (`:18`), and the `500` response echoes Webflow's error payload (`:60`). It also logs the whole body (`:7`).
- **Fix:** Require `Authorization: Bearer ${WEBFLOW_WEBHOOK_SECRET}` with a constant-time compare (reuse `secretMatches` from `cron/keep-alive`). Create items as `isDraft:true`. Validate field lengths. Return generic errors. Or remove the route if Zapier no longer uses it.
- **Test:** Mock `global.fetch`. POST without a header → expect 401 and `fetch` not called. POST with the correct secret → `fetch` called once with `isDraft: true`.

### SEC-4 — `/api/export-pdf` and `/api/export-pdf-fallback` render attacker HTML with JavaScript in server-side Chrome (SSRF and cost DoS)
- **Files:** `app/api/export-pdf/route.ts:12-51`, `app/api/export-pdf-fallback/route.ts:15-53`, `lib/pdf-chrome.ts:38-42`
- **What's wrong:**
  - There's no auth and no size limit. `html` and `css` go straight into `page.setContent()` with JavaScript enabled and no request interception. `css` can close `</style>` and inject `<script>`.
  - Failure scenario: POST `{"html":"<iframe src='http://169.254.169.254/latest/meta-data/iam/' width=800 height=800></iframe>","css":"x"}`. Chrome renders the internal response into the PDF and returns it to the attacker. Any internal or VPC-reachable host, or `127.0.0.1` service, works the same way (iframes aren't subject to CORS). On Vercel the Lambda runtime API on localhost is reachable too.
  - Each request launches a full Chromium with `maxDuration = 60`. A loop of unauthenticated requests costs compute and can exhaust function concurrency.
  - `@sparticuz/chromium` runs with `--no-sandbox`. Untrusted JavaScript in an unsandboxed, pinned Chromium is an RCE risk if any Chrome n-day applies.
  - The fallback route also loads `html2pdf` from unpkg at runtime (a supply-chain dependency on every request) and returns `detail` and `hint` with internal error text (`:116-121`).
- **Fix:** Require auth. Cap body size (for example 2 MB). Call `page.setJavaScriptEnabled(false)` on the primary route. Call `page.setRequestInterception(true)` and allow only `data:`, `fonts.googleapis.com` and `fonts.gstatic.com`, aborting everything else. Strip `<script>`, `<iframe>`, `<object>` and `<embed>` from `html` (or sanitize it with DOMPurify/`sanitize-html`). Reject `css` that contains `</style`. Rate limit per user. Delete `export-pdf-fallback`: the client already has an html2pdf fallback, and its only server-side caller is a script.
- **Test:** Mock `puppeteer-core` and `@/lib/pdf-chrome`. Assert that 401 is returned without a session. With a session, assert `page.setJavaScriptEnabled(false)` and `page.setRequestInterception(true)` were called, and that an intercepted request to `http://169.254.169.254/` gets `abort()`. Assert that a 5 MB body returns 413.

### SEC-5 — `/api/verify-subscription` re-grants a paid tier to cancelled users and misses real paying users **[repro ✓]**
- **File:** `app/api/verify-subscription/route.ts:53-64` and `:87-108`
- **What's wrong:**
  1. The route finds *any* completed subscription Checkout Session for the user (`status === "complete"` stays true forever), then sets `subscription_status:"active"` and the tier from metadata. It **never checks `sub.status`**. Scenario: a user subscribes to Agency and cancels; the webhook `customer.subscription.deleted` sets them to Starter. They then call `POST /api/verify-subscription`, which the dashboard's `SubscriptionRefresh` component also calls. If their old session is still in the window from point 2, they are set back to Agency/active for free.
  2. `stripe.checkout.sessions.list({ limit: 5 })` has **no customer filter**, so it only sees the 5 most recent sessions across the whole Stripe account. Under any real traffic, a user who just paid won't find their session, so the fallback fails exactly when the webhook failed (SEC-6).
- **Fix:** Have the success URL carry `session_id={CHECKOUT_SESSION_ID}`. In this route, `stripe.checkout.sessions.retrieve(id, { expand: ["subscription"] })`, then check `metadata.user_id === user.id`, `status === "complete"`, and `subscription.status ∈ {active, trialing}`. Take the plan from the subscription price via `priceIdToPlan` rather than from metadata. Never write `status:"active"` for a non-active subscription. Remove the user-client fallback (SEC-10).
- **Test:** `sec.test.ts › "verify-subscription re-upgrades a cancelled user"` passes today: the subscription retrieve returns `status:"canceled"` and the profile is still set to agency/active. Invert the expectation (`updated` falsy, `adminUpdate` not called).

### SEC-6 — The Stripe webhook acknowledges events it failed to apply, so Stripe never retries **[repro ✓]**
- **File:** `app/api/webhook/route.ts:104-107, 115-117, 160-162, 196-199, 218-222` (every handler catches and logs, then returns), `:301`
- **What's wrong:** If the Supabase update fails (network error, schema change, misconfigured admin key), the handler logs it and the route still returns `200 {received:true}`. Stripe treats the event as delivered and **never retries**. The customer is charged but stays on Starter, and the only recovery path is SEC-5's broken fallback. The same happens for `customer.subscription.deleted`: a failed write leaves a cancelled user on a paid tier. An `.update().eq("id", userId)` that matches 0 rows (profile row missing) also passes silently.
- **Fix:** Have handlers throw. Return `500` from the route when processing fails, so Stripe retries for 3 days. Keep `400` only for signature failures. Use `.select()` and treat 0 updated rows as an error.
- **Test:** `sec2.test.ts › "DB failure still returns 200"` passes today. Invert it to `expect(res.status).toBe(500)`.

### SEC-7 — Webhook tier mapping: an unknown price gives `starter` with a 99-guide limit, renewals can downgrade paying users, and `unpaid`/`past_due` users keep their paid tier **[repro ✓]**
- **File:** `app/api/webhook/route.ts:166-201`
- **What's wrong:**
  - `const guidesLimit = plan === "pro" ? 5 : 99`. When `priceIdToPlan()` returns `null`, the row becomes `subscription_tier:"starter", guides_limit:99`. `plan` is null for a legacy or grandfathered price, a price created later, a missing `STRIPE_*_PRICE_ID` env var in the webhook's deployment, or a `STRIPE_MODE` mismatch.
  - `customer.subscription.updated` fires on **every renewal**. So a paying customer whose price doesn't match the env IDs is downgraded to Starter at their next billing cycle, while still being charged.
  - When `status` is `past_due`, `unpaid` or `incomplete_expired`, the tier stays `pro`/`agency` and only `subscription_status` becomes `"inactive"`. No code gates on `subscription_status`: `expand-style-guide:39-41`, `save-style-guide:73-74` and `preview:67-69` all check only `subscription_tier`. A user whose card fails keeps Pro until Stripe *deletes* the subscription, which may never happen if dunning is set to "mark unpaid".
  - Status mapping: Stripe's `"canceled"` becomes `"inactive"`, while the deleted handler writes `"cancelled"`, so there are two spellings for the same state.
- **Fix:** When `plan === null`, log an error and **don't touch** the tier. Better, map by `price.lookup_key` or product metadata instead of env IDs. Get limits from one table (SIMP-2). Derive the effective tier as `status ∈ {active, trialing} ? plan : "starter"`. Gate features on the effective tier.
- **Test:** `sec2.test.ts › "unknown price -> tier starter but guides_limit 99"` and `"past_due keeps paid tier"` both pass today. Invert them: for an unknown price, expect `adminUpdate` to be called without `subscription_tier`; for `unpaid`, expect `subscription_tier:"starter"`.

### SEC-8 — Upgrading from Pro to Agency creates a second subscription and a second customer (double billing)
- **Files:** `app/dashboard/billing/BillingActions.tsx:97-103` (offers "Get Agency" to Pro users), `app/api/create-subscription-session/route.ts:86-104`
- **What's wrong:** The checkout session is created with `customer_email` and no `customer`, and there's no check for an existing active subscription. A Pro user who clicks "Get Agency" gets a **new Stripe customer and a new subscription**. The webhook then overwrites `stripe_customer_id` and `stripe_subscription_id` (`webhook/route.ts:95-96`). The old Pro subscription keeps billing every month. It no longer matches any profile row, and because the portal now opens for the *new* customer (`create-portal-session/route.ts:32-50`), the user can't even see the Pro subscription to cancel it. The same applies to any user who double-clicks or subscribes twice.
- **Fix:** In `create-subscription-session`, load the profile. If it has `stripe_customer_id`, pass `customer`. If it has an active `stripe_subscription_id`, don't create a new checkout: either send the user to the portal with a `subscription_update` flow, or call `stripe.subscriptions.update(subId, { items: [{ id, price: agencyPrice }], proration_behavior: "create_prorations" })`. Reject a plan the user already has.
- **Test:** Mock the profile as `{ subscription_tier:"pro", stripe_customer_id:"cus_1", stripe_subscription_id:"sub_1", subscription_status:"active" }`. POST `{plan:"agency"}` and expect `checkout.sessions.create` not to be called with `mode:"subscription"`; expect a portal or subscription-update path, or a 409. For a user with no subscription, expect `create` to be called with `customer:"cus_1"` when one exists.

### SEC-9 — Paid OpenAI routes have no rate limiting, and some have no auth or tier gate
Nothing in the repo does rate limiting (no matches for ratelimit/upstash/lru-cache).

| Route | Auth | Tier gate | Abuse |
|---|---|---|---|
| `generate-styleguide/route.ts:26` | **none** | **none** | see SEC-1 |
| `ai-assist/route.ts:63-145` | **none** | none | anonymous gpt-5.2 proxy: arbitrary 5k-char text plus arbitrary `context` (unbounded) |
| `preview/route.ts:21-80` | optional | Pro/Agency get full generation | anonymous flow by design, but unthrottled; multiple LLM calls per hit |
| `extract-website/route.ts:65` | **none** | none | by design for anonymous onboarding, but unthrottled; also SSRF (SEC-13) |
| `ai/command/route.ts:34-78` | login | **none** | any free account; client chooses **`model`** (`:61,77`: `model || 'gpt-5-mini'`, passed verbatim to `openai(modelId)`), so it can request the most expensive model; arbitrary `messages` with no length cap |
| `rewrite-section/route.ts:7-18` | login | none | marked DEPRECATED in a comment but still live; gpt-5.2 with 2000 output tokens |
| `expand-style-guide` | login | pro/agency | OK, but should also check `subscription_status` (SEC-7) |

- **Failure scenario:** a script hitting `/api/ai-assist` or `/api/generate-styleguide` drains the OpenAI budget or org rate limit, which takes down generation for paying users. Since sign-up is free, "login required" is not a cost control.
- **Fix:** Add a shared `rateLimit(key, limit, window)` helper (Upstash Redis, or a Supabase table with an atomic upsert). Key it by user ID, falling back to IP. Apply it to every route that calls OpenAI. Require auth on `ai-assist`. Allowlist models in `ai/command` (`const ALLOWED = new Set(["gpt-5-mini"])`) and cap `messages` length and total characters. Delete `rewrite-section`. Gate the AI editor routes on paid tier if that's the product intent.
- **Test:** `ai/command`: mock `@ai-sdk/openai` `createOpenAI` to return a spy. POST `{model:"o3-pro"}` and expect the spy to be called with `"gpt-5-mini"` (or a 400). Rate limit: call the handler N+1 times with a mocked limiter store and expect 429 on the last call. `ai-assist`: with no session, expect 401.

### SEC-10 — Billing columns on `profiles` may be writable by users; schema and RLS aren't in version control (verify in the DB)
- **Files:** `supabase/migrations/` contains only `001_create_blog_posts.sql`. The code uses `profiles` and `style_guides`, which have **no migration, no RLS policy, and no new-user trigger** in the repo. `app/api/verify-subscription/route.ts:110-125` falls back to updating `subscription_tier`, `subscription_status`, `guides_limit`, `stripe_customer_id` and `stripe_subscription_id` **with the user's own JWT client**.
- **What's wrong:** The fallback only works if RLS lets an authenticated user `UPDATE` their own row's billing columns. If it does, any user can open devtools and run `createClient().from("profiles").update({subscription_tier:"agency",subscription_status:"active"}).eq("id", me)` with the public anon key, and get Agency for free. I couldn't confirm the live policy from the repo, so this is conditional. The code was written expecting it to succeed, which is the red flag. Separately, `001_create_blog_posts.sql` creates `public.blog_posts` **without `ENABLE ROW LEVEL SECURITY`**. Supabase's default grants give `anon` full CRUD on public tables, so if that migration was applied, anyone with the anon key can insert or delete blog posts. The table isn't referenced by the code anymore.
- **Fix:** Run `supabase db pull` and commit the real schema. Enable RLS on `profiles` and `style_guides`. Policies: `style_guides` select/insert/update/delete `using (user_id = auth.uid()) with check (user_id = auth.uid())`. `profiles` select own row only, and either no UPDATE policy at all or `revoke update (subscription_tier, subscription_status, guides_limit, stripe_customer_id, stripe_subscription_id, current_period_end) on profiles from authenticated`. Enforce the guide limit with a `BEFORE INSERT` trigger on `style_guides` (also fixes the race in SEC-12). Remove the user-client fallback in verify-subscription. Drop `blog_posts` or enable RLS on it.
- **Test:** This needs an integration test against `supabase start`, not a unit test: sign in as a test user with the anon key, try `profiles.update({subscription_tier:"agency"})`, and expect an error or 0 rows. For the unit level: mock `getSupabaseAdmin` to throw and assert the user client's `.update` is **not** called and the route returns 500.

---

## MEDIUM

### SEC-11 — Open redirect after login (`next` / `redirectTo`) **[repro ✓]**
- **Files:** `app/auth/callback/route.ts:10,31` (`NextResponse.redirect(\`${origin}${next}\`)`), `app/sign-in/page.tsx:17,43,62`, `app/sign-up/page.tsx:19,53,76,99`
- **What's wrong:** `next=@evil.com/phish` produces `https://toneofvoice.app@evil.com/phish`, whose host is **evil.com** (verified with `new URL`). `next=.evil.com` produces `toneofvoice.app.evil.com`. Phishing link: `https://toneofvoice.app/sign-in?redirectTo=@evil.com/login`. The victim signs in with Google; the OAuth `redirectTo` is our own `/auth/callback?next=@evil.com/login`, which passes Supabase's allowlist; the callback then 302s to evil.com, which shows a fake "session expired, re-enter password" page. The password sign-in path does `router.push(redirectTo)` directly, so `redirectTo=https://evil.com` also works.
- **Fix:** Add `safeRedirectPath(p)` and use it in all three places: accept only values that start with a single `/`, don't start with `//` or `/\`, and contain no `@`; otherwise fall back to `/auth/claim`. In the callback, use `new URL(next, origin)` and check `.origin === origin`.
- **Test:** `sec2.test.ts › "open redirect via next=@evil.com"` passes today (the location host is evil.com). Invert it: expect `new URL(location).origin === "https://toneofvoice.app"`. Add a pure unit test for `safeRedirectPath` covering `@evil.com`, `//evil.com`, `/\evil.com`, `https://evil.com` and `/dashboard`.

### SEC-12 — Guide limits: enforced in one place, inconsistent numbers, silent overwrite at the limit, and a race **[repro ✓]**
- **Files and numbers:**
  - `save-style-guide/route.ts:74`: starter 1, **pro 2**, agency 99. This is the only server-side enforcement.
  - `webhook/route.ts:80,183` and `verify-subscription/route.ts:84` write `guides_limit` **pro 5** / agency 99 / starter 1. The column is never read for enforcement; `save-style-guide` selects it and ignores it.
  - `user-guide-limit/route.ts:22` and `dashboard/billing/page.tsx:32`: **starter 0** (never "at limit").
  - `dashboard/page.tsx:42`: starter 1.
  - UI copy: `UpgradeNudgeModal.tsx:45` says "Pro: **5** guides"; `app/guide/page.tsx:1606` and `BillingPlansGrid.tsx:7` say "**2** guides".
- **What's wrong:**
  1. **Data loss.** When `count >= limit`, `save-style-guide` (`:83-105`) *overwrites the most recently updated guide* with the new title and content and returns `200 success`. A Pro user with 2 guides who generates a third brand silently loses their most recent guide. The "save preview" behaviour was meant for Starter but applies to every tier.
  2. **Race (TOCTOU).** Count-then-insert with no lock, so parallel POSTs can exceed the limit.
  3. Users are told Pro gets 5 guides but are blocked at 2, a billing and marketing mismatch.
  4. `brand-details/page.tsx` uses `user-guide-limit`, where Starter can never be "at limit", so Starter users never see the nudge before generating.
- **Fix:** Create one `lib/tiers.ts` (SIMP-2) and pick the real numbers. Enforce with a DB trigger, or an `insert … where (select count(*) …) < limit` RPC. Only overwrite-at-limit for Starter, and only when the most recent guide is the unsaved preview; otherwise return 403 so the UI can prompt.
- **Test:** `sec2.test.ts › "pro user at limit: new guide silently overwrites most recent guide"` passes today. Invert it to expect 403 and no `update`. Add a table-driven test over `TIER_LIMITS` that imports the same constant into `save-style-guide`, `user-guide-limit` and the UI copy.

### SEC-13 — SSRF in `extract-website` because `lib/url-validation.ts` blocks only the literal string `localhost`
- **Files:** `lib/url-validation.ts:29-31`, used by `app/api/extract-website/route.ts:223,250`, and `lib/cheerio-site-scraper.ts:20,46-57`
- **What's wrong:** `http://127.0.0.1:…`, `http://169.254.169.254/…`, `http://10.0.0.5/`, `http://[::1]/`, `http://0.0.0.0/`, decimal IPs (`http://2130706433/`), and DNS names that resolve to private IPs all pass. `fetch` follows redirects, so a public URL that 302s to an internal one also works. The scraper also follows one `/about`-like link taken *from the fetched page* (`:46-52`), so an attacker page can point it anywhere. Up to 1500 characters of the response go into the LLM prompt and come back in the generated "brand description", which makes this a partial-read SSRF on an unauthenticated route.
- **Fix:** In `validateUrl`, allow only `http`/`https` and ports 80/443. Resolve DNS (`dns.promises.lookup(host, { all: true })`) and reject private, loopback, link-local, CGNAT and ULA ranges (use `ipaddr.js` `range() !== "unicast"`). Fetch with `redirect: "manual"` and re-validate each hop (maximum 3). Apply the same checks to subpage URLs.
- **Test:** A pure unit test on `validateUrl` (make it async if DNS is added): `expect(await validateUrl("http://169.254.169.254/")).toMatchObject({isValid:false})`, and the same for `127.0.0.1`, `[::1]`, `2130706433`, `10.1.2.3` and `ftp://x`. Mock `dns.promises.lookup` to return `10.0.0.1` for `internal.example.com` and expect it to be invalid.

### SEC-14 — `next.config.js` inlines `OPENAI_API_KEY` at build time (latent client leak)
- **File:** `next.config.js:4-8`
- **What's wrong:** Values in `env` are string-replaced at build time into **every** bundle that references `process.env.OPENAI_API_KEY`, client bundles included. That exposure is opt-out rather than opt-in. I checked: no client component currently references it. The references are in `app/api/ai/command`, `rewrite-section`, `ai-assist` and `lib/langsmith-openai.ts`, and no `"use client"` file imports `lib/openai`, `lib/langsmith-openai` or `lib/template-processor`. The current `.next` build has no `sk-` strings because the key wasn't set at build time. But one import of `lib/openai.ts` from a client component (or from a shared util a client imports) would ship the live key to every browser with no warning. It also bakes the key into server build artifacts and caches. Server code can read `process.env` at runtime anyway, so the entry is unnecessary.
- **Fix:** Remove `OPENAI_API_KEY` and `STRIPE_PUBLISHABLE_KEY` from `env` (use `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` if the client needs it). Add `import "server-only"` to `lib/openai.ts`, `lib/langsmith-openai.ts`, `lib/supabase-admin.ts`, `lib/email-service.ts` and `lib/pdf-chrome.ts`, so an accidental client import fails the build.
- **Test:** A unit test that reads `next.config.js` and asserts `!("OPENAI_API_KEY" in config.env ?? {})`. A CI step after `next build`: `! grep -rE "sk-(proj-)?[A-Za-z0-9_-]{20,}" .next/static`.

### SEC-15 — Stripe API version mismatch means `current_period_end` is read from the wrong object
- **Files:** `webhook/route.ts:20` (`apiVersion:"2023-10-16"` against stripe@18, whose types are `2025-03-31.basil`), `:85-86,180-181`; `verify-subscription/route.ts:89-90`. These are all in the tsc baseline as TS2339/TS2322.
- **What's wrong:** In API version `basil`, `current_period_end` moved from `Subscription` to `SubscriptionItem`. Calls made through the SDK pin 2023-10-16, so they still work. But **webhook event payloads use the endpoint's API version configured in the Stripe dashboard**, not the SDK's. If the endpoint is on basil or later, `handleSubscriptionUpdated` writes `current_period_end: null` on every update and renewal, and the billing page (`dashboard/billing/page.tsx:34`) loses "next billing date". This depends on the endpoint version, which can't be seen from the repo.
- **Fix:** Upgrade `apiVersion` to the SDK's version. Read `subscription.items.data[0].current_period_end ?? subscription.current_period_end`. Set the webhook endpoint's API version to match. This also clears 7 tsc errors.
- **Test:** A webhook unit test where the event's subscription object has the period end only on `items.data[0].current_period_end`: expect `adminUpdate` to be called with a non-null `current_period_end`.

### SEC-16 — Webhook has no idempotency or ordering guard, and the email dedupe is in-memory
- **File:** `webhook/route.ts:24,136-141,174-201`
- **What's wrong:** There's no `event.id` dedupe store. Stripe retries and duplicate deliveries re-run handlers. `sentEmails` is a module-level `Set`, which is empty on every cold start and per instance on serverless, so retries send duplicate "thank you" emails. `customer.subscription.updated` events can arrive out of order (Stripe doesn't guarantee ordering), and an older event can overwrite a newer state, for example re-activating after a downgrade.
- **Fix:** Add a `stripe_events(id text primary key, processed_at)` table. `insert … on conflict do nothing` and skip the event if it already exists. For subscription events, store `subscription.created`/`event.created` and ignore events older than the stored `last_event_at`, or simply re-fetch `stripe.subscriptions.retrieve(id)` and write its *current* state.
- **Test:** Deliver the same `constructEvent` result twice with a mocked `stripe_events` insert that returns a conflict the second time. Expect the profile update to be called once.

---

## LOW

### SEC-17 — Dead, unauthenticated legacy one-time checkout
`app/api/create-checkout-session/route.ts` has no callers in `app/`, `components/` or `hooks/`. Anyone can create $149 sessions with arbitrary `emailCaptureToken` metadata. `new Stripe(STRIPE_SECRET_KEY!)` runs at module load (`:12`). Its webhook path (`handlePaymentSuccess`) emails a `/guide?session_id=` link. **Fix:** delete the route and the `mode: "payment"` branch in the webhook (or gate it). **Test:** a route-existence test is enough after removal.

### SEC-18 — A public "API Testing" page is served at `/api`
`app/api/page.tsx` is a client page that drives `extract-website` and `generate-styleguide` from a form, which makes SEC-1 easier to abuse. **Fix:** delete it, or render only when `NODE_ENV !== "production"`.

### SEC-19 — Committed secret in docs, and the old admin auth was forgeable
`docs/SECURITY_REVIEW.md` ("Password Security" section) contains the literal `ADMIN_BLOG_PASSWORD` value. The historical `cookies.txt` (commit `b3292a3`, removed in `116caae`) shows the admin session cookie was the static value `admin-blog-session=authenticated`, so anyone could have forged it. The blog admin routes no longer exist in `app/`, but **rotate that password wherever it's reused** and remove it from the doc. Git history keeps it.

### SEC-20 — Internal error details leak to clients
`save-style-guide/route.ts:53,128` and `delete-style-guide/route.ts:50` return Postgres `error.message` (table and constraint names). `export-pdf-fallback/route.ts:118-120` returns `detail` and an env-var `hint`. `preview/route.ts:94-98` returns `details`. `test-email/route.ts:40,46` and `post-to-webflow/route.js:18,60,66` return raw errors and payloads. `tasks/lessons.md:7` already asks for this not to happen. **Fix:** log server-side and return generic messages. **Test:** mock the Supabase error `{message:"duplicate key value violates unique constraint \"style_guides_pkey\""}` and assert the response body doesn't contain `style_guides`.

### SEC-21 — Middleware edge cases
`lib/supabase-middleware.ts:12-14` returns a bare `NextResponse` when env is missing, but `middleware.ts:5` destructures `{supabaseResponse, user}` (in the tsc baseline). The result is that `middleware` returns `undefined` and `/dashboard` always redirects. `middleware.ts:17` uses `Response.redirect(url)`, which drops any refreshed auth cookies set on `supabaseResponse` (Supabase's SSR guide says to copy cookies onto redirect responses). **Fix:** always return `{ supabaseResponse, user: null }`. Redirect with `NextResponse.redirect(url)` and copy `supabaseResponse.cookies`. **Test:** unit-test `updateSession` with env unset and expect `{ user: null }`.

### SEC-22 — Dead server actions with fake auth
`app/actions.ts:37-43`: `verifyAccessToken()` always returns `{ valid:true }`, and `processPayment()` mints `Math.random()` tokens (`lib/email-service.ts:86-89`). Nothing imports this file today, so Next doesn't register the actions. But a single import would expose an unauthenticated server action. **Fix:** delete `app/actions.ts` and the mock functions in `email-service.ts` (`sendEmail`, `scheduleEmail`, `generateSecureToken`, `sendPurchaseConfirmationEmail`).

### SEC-23 — Image optimizer accepts any HTTPS host
`next.config.js:20-28` sets `remotePatterns: [{ protocol:'https', hostname:'**' }]`, so `/_next/image?url=https://anything` acts as an open image proxy that costs bandwidth and optimization quota. Next 16 blocks private IPs by default, so this isn't SSRF. **Fix:** list the hosts that are actually used.

### SEC-24 — Unescaped Stripe customer name in the HTML email
`lib/email-service.ts:168,180` interpolates `customerName.split(' ')[0]` raw into HTML. The name comes from the payer at checkout and the email goes to the payer, so impact is minimal (HTML injection into your own receipt). **Fix:** HTML-escape interpolated values.

---

## Simplification opportunities

- **SIMP-1 — One Stripe module.** The mode, key, `getStripe()` and `apiVersion` boilerplate is copied into 5 routes (`webhook`, `create-checkout-session`, `create-subscription-session`, `create-portal-session`, `verify-subscription`). The price-ID selection is duplicated in `create-subscription-session:20-27` and `webhook:166-172`. Create `lib/stripe.ts` exporting `getStripe()`, `PRICE_IDS`, `planToPriceId()` and `priceIdToPlan()`. This fixes SEC-15's version pin in one place.
- **SIMP-2 — One tier module.** `(tier === "free" ? "starter" : tier) ?? "starter"` appears in at least 8 places (`save`, `load`, `user-guide-limit`, `user-subscription-tier`, `expand`, `preview`, `dashboard/page`, `billing/page`, `guide/page`). Limit numbers are hard-coded in 6 places with 3 different answers (SEC-12). Create `lib/tiers.ts` with `normalizeTier()`, `effectiveTier(profile)` (which accounts for `subscription_status`), `TIER_LIMITS`, `canExpand(tier)` and `canSave(tier, used)`. Import it from routes and UI copy.
- **SIMP-3 — Auth helper.** Around 10 routes repeat `createClient()`, `auth.getUser()`, a 401, and `MissingSupabaseConfigError` mapped to 503. Add `requireUser(): Promise<{ supabase, user } | NextResponse>`, or a `withAuth(handler)` wrapper that also applies the rate limiter from SEC-9. This makes it hard to forget auth on a new route, which is how SEC-1, SEC-2, SEC-3 and SEC-4 happened.
- **SIMP-4 — One "activate subscription" function.** `webhook.handleSubscriptionCheckout:80-102` and `verify-subscription:84-108` build the same profile payload. Extract `applySubscriptionToProfile(userId, subscription)` that derives the plan from the price and the status from the subscription, and call it from both.
- **SIMP-5 — Merge or delete the PDF routes.** `export-pdf` and `export-pdf-fallback` share about 80% of their code. Keep one hardened route (SEC-4).
- **SIMP-6 — Delete dead code.** `lib/supabase.ts` (no importers), `app/actions.ts`, the mock functions in `email-service.ts`, `create-checkout-session`, `rewrite-section` (self-labelled DEPRECATED), `app/api/page.tsx`, `test-email`, `normalizeWebhookUrl` in the webhook (it only feeds a log line), and the unused `import { OpenAI } from "openai"` in `lib/api-utils.ts` (which client pages import).
- **SIMP-7 — Narrow the middleware matcher.** It runs `supabase.auth.getUser()` (a network round trip) on every `/api/*` request except the webhook, including cron, PDF and template routes, even though API routes do their own auth. Limit the matcher to `/dashboard/:path*` plus the pages that need session refresh. Next 16 also deprecates `middleware.ts` in favour of `proxy.ts`.
- **SIMP-8 — `save-style-guide` has two copies of the update payload** (`:37-44` and `:89-96`). Extract a `toRow(body)` helper.
- **SIMP-9 — Commit the schema.** `supabase db pull` into `supabase/migrations`, so RLS, the profile trigger and constraints get reviewed and tested (SEC-10). `scripts/check-schema.mjs` exists because the schema can't be seen from the repo.
