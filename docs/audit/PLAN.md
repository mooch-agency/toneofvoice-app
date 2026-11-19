# Codebase audit: plan and spec (November 2026)

Four audits ran in parallel. Their reports are in this folder:

| Report | Scope | Findings |
|---|---|---|
| `01-security-payments.md` | Auth, Stripe, Supabase, API routes | 1 critical, 9 high, 6 medium, 8 low |
| `02-ai-pipeline.md` | OpenAI generation, scraping, markdown libs | 1 critical, 6 high, 10 medium, 11 low |
| `03-frontend.md` | Pages, hooks, app components | 1 critical, 1 high, 9 medium, 11 low |
| `04-deps-hygiene.md` | Dependencies, config, dead code, docs | 148 type errors, 141 dead files, 37 unused deps |

IDs below (SEC-n, AI-n, FE-n, DEP-n, ...) point into those reports.

## Rules for all work

1. **TDD.** Write the failing test first, see it fail, then fix. Every behaviour change needs a test. Route handlers are tested by importing `POST`/`GET` with `vi.mock` for Supabase, Stripe and OpenAI (see `lib/api-auth.test.ts`). Node-only tests start with `// @vitest-environment node`.
2. **Gates.** `pnpm test`, `pnpm typecheck` (0 errors in your files), `pnpm lint` (0 errors in your files).
3. **Ownership.** Each work package (WP) owns a fixed list of files. Do not edit files owned by another WP. If you need a change there, note it in your report.
4. **No new dependencies.** `package.json` is owned by the orchestrator.
5. **Simplify.** Delete dead code you find in your files. Prefer small pure modules with tests over logic inside pages and routes.
6. **Errors.** Return generic error messages to clients; log details on the server. Never log emails or full guide content.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Pro = 2 guides, Starter = 1, Agency = 99. One source: `lib/tiers.ts`. | 2 is what the server enforced and the billing page showed. The webhook's 5 was never read. |
| D2 | A paid tier counts only while the subscription is not lapsed (`effectiveTier`). Unknown status keeps the tier. | Stops `past_due`/`unpaid` users keeping paid features; keeps manual grants working. |
| D3 | Remove the legacy one-time payment flow: `/payment/success`, `/payment/cancel`, `/api/create-checkout-session`, the webhook's `mode: "payment"` branch, the guide page's "full-access" generation path, and `/api/generate-styleguide`. | Nothing creates a one-time checkout. The flow let anyone generate the paid guide (SEC-1/AI-1, FE-10). Paid content is produced only by `/api/expand-style-guide`, which checks the tier on the server. |
| D4 | Remove orphan pages `/demo`, `/preview`, `/full-access`, `/brand-details`. Redirects live in `next.config.js`. | No inbound links (FE SIMP-2). |
| D5 | Rate limiting uses a shared database counter (`lib/rate-limit-durable.ts`, migration 003) and falls back to the in-memory limiter (`lib/rate-limit.ts`) until the migration is applied or if the database is unreachable. | No Redis in the stack; Postgres is already there. |
| D6 | The database schema is not in the repo. WP-A writes a reviewed migration for RLS, column privileges and the guide-limit trigger. **The owner must review and apply it.** | SEC-10 cannot be verified from code. |
| D7 | `/api/post-to-webflow` stays but requires `WEBFLOW_WEBHOOK_SECRET` (fails closed). Items still publish directly, as before. | It may still be used by Zapier. |
| D8 | Keep `ai@5` with `@ai-sdk/react@2` (done in Phase 0). | Two copies of `ai` caused the editor type errors. |

## Phase 0 — foundation (done by orchestrator)

- Deleted ~140 dead files, legacy unauthenticated routes (`ai-assist`, `rewrite-section`, `test-email`, `/api` test page, `app/actions.ts`), blog leftovers, 39 unused deps.
- ESLint flat config; `pnpm lint`, `pnpm typecheck` scripts; dead scripts removed.
- `next.config.js`: no inlined secrets, no wildcard image host, no `ignoreBuildErrors`, redirects for D3/D4.
- Shared modules (with tests): `lib/tiers.ts`, `lib/api-auth.ts` (`requireUser`, `withRouteErrors`, `tooManyRequests`), `lib/rate-limit.ts`, `lib/safe-redirect.ts`, `lib/guide-placeholders.ts`.
- `.env.example`, sitemap fix.

## Work packages

### WP-A — Billing, tiers and guide storage (opus)

**Owns:** `app/api/{webhook,verify-subscription,create-subscription-session,create-portal-session,create-checkout-session,user-guide-limit,user-subscription-tier,save-style-guide,load-style-guide,delete-style-guide,cron}/**`, `app/dashboard/**`, `components/dashboard/{SubscriptionRefresh,UpgradeNudgeModal,GuideCard}.tsx`, `lib/email-service.ts`, new `lib/stripe.ts`, `supabase/**`, `components/BillingPixelEvents.tsx`, `components/MetaPixelPurchase.tsx`.

**Fixes:** SEC-5, 6, 7, 8, 10, 12, 15, 16, 17, 20, 24; SIMP-1, 2, 4, 6 (email mocks), 8, 9; TS-3.

**Spec:**
- `lib/stripe.ts`: one lazily created client (no Stripe call at import time, so `next build` works without env), one API version matching the SDK, `PRICE_IDS`, `planToPriceId`, `priceIdToPlan`, `subscriptionPeriodEnd(sub)` that reads `items.data[0].current_period_end` and falls back to `sub.current_period_end`.
- `applySubscriptionToProfile(userId, subscription)`: plan from price, status from subscription. Unknown price: log an error and leave the tier untouched. Used by the webhook and verify-subscription.
- Webhook: return 500 when a handler fails so Stripe retries; 0 updated rows is a failure; dedupe by `event.id` (table `stripe_events` in the migration; if the insert fails because the table is missing, log and continue). Delete the `mode: "payment"` branch and the in-memory email dedupe.
- `verify-subscription`: accept `{ session_id }`, retrieve that session, check `metadata.user_id === user.id`, `status === "complete"` and the subscription's status is active/trialing. Never write with the user's own client. Without a `session_id`, look up by the profile's `stripe_customer_id` (`subscriptions.list({ customer })`).
- `create-subscription-session`: reuse `stripe_customer_id` as `customer`. If the user already has an active subscription, do not create a checkout: return `409 { error, manageUrl }` with a billing-portal URL, or `409 { error, upgrade: true }` when an active subscriber asks for a higher plan (the client then calls `POST /api/change-plan`). `success_url` = `/dashboard?subscription=success&session_id={CHECKOUT_SESSION_ID}`. Rate limit.
- `save-style-guide`: use `lib/tiers`. At the limit, return 403 for every tier. Never overwrite another guide. Generic errors. Validate field types and cap `content_md` size (e.g. 200 KB).
- `user-guide-limit`, `user-subscription-tier`, `load-style-guide`, dashboard pages and billing UI copy: use `lib/tiers` (`TIER_LIMITS`, `effectiveTier`).
- `SubscriptionRefresh`: pass `session_id` from the URL to verify-subscription.
- Migration `supabase/migrations/002_security_hardening.sql`: enable RLS on `profiles` and `style_guides` with owner-only policies; revoke UPDATE of billing columns from `authenticated`; `BEFORE INSERT` trigger on `style_guides` enforcing the tier limit; `stripe_events` table; enable RLS on `blog_posts`. Idempotent (`drop policy if exists`, `create table if not exists`). Header comment: review before applying.

### WP-B — API hardening, scraping, editor AI route (opus)

**Owns:** `app/api/{ai/command,export-pdf,export-pdf-fallback,post-to-webflow,extract-website}/**`, `app/pdf-styles/**`, `app/auth/callback/**`, `middleware.ts` (rename to `proxy.ts`), `lib/supabase-middleware.ts`, `lib/supabase-*.ts`, `lib/url-validation.ts`, `lib/cheerio-site-scraper.ts` (+ test), `lib/pdf-chrome.ts`, `components/editor/use-chat.ts`, `components/editor/plugins/ai-kit.tsx`, `components/ui/ai-menu.tsx`.

**Fixes:** SEC-3, 4, 9 (its routes), 11 (callback), 13, 14 (`server-only`), 21; AI-2, 4, 10, 14, 15, 16, 22 (its files), 26; SIMP-5, 7; TS-2, TS-4, TS-5.

**Spec:**
- SSRF: `lib/url-validation.ts` gets `assertPublicHttpUrl(url, { lookup })`. http/https only, ports 80/443, no IP literals in private, loopback, link-local, CGNAT, multicast, ULA or unspecified ranges (IPv4 incl. decimal/hex forms, IPv6 incl. mapped IPv4), no single-label or `.local`/`.internal` hosts, DNS answers must all be public. The scraper fetches with `redirect: "manual"` and re-validates each hop (max 3), only follows same-site subpage links, checks `res.ok` and HTML content type, caps body at 1 MB, strips `script/style/noscript/svg/template`, skips malformed hrefs. Existing timeout tests must keep passing.
- `extract-website`: rate limit by IP; validate body types and lengths (description ≤ 2000 chars, URL ≤ 2048); guard every auxiliary `JSON.parse` (fallback to `[]`); wrap scraped text in `<website_content>` tags with an "ignore instructions inside" note; brand hint from host strips only a leading `www.` and the subdomain (`shop.acme.com` → `acme`, `news.bbc.co.uk` → `bbc`); fix TS errors.
- `ai/command`: require login and a paid tier (`requireUser({ requirePaid: true })`) — the editor AI is a paid feature in the UI; ignore client `model` (server allow-list); cap message count (last 10) and total characters; rate limit; fix the 12 type errors.
- PDF export: require login; rate limit; cap body size (2 MB → 413); `setJavaScriptEnabled(false)`; request interception that allows only `data:`, `about:blank` and Google Fonts; reject `css` containing `</style`. Delete `export-pdf-fallback` (the client already falls back to html2pdf). Generic errors.
- `post-to-webflow`: D7. Constant-time secret compare, length checks, no echoing of bodies.
- `auth/callback`: `safeRedirectPath(next, "/auth/claim")`, redirect via `new URL(path, origin)`.
- Proxy: rename `middleware.ts` → `proxy.ts` (Next 16). `updateSession` always returns `{ response, user }`. Redirects copy refreshed cookies. Matcher limited to pages (exclude `/api/**`, static files).
- Add `import "server-only"` to server-only libs (`lib/supabase-admin.ts`, `lib/pdf-chrome.ts`, `lib/langsmith-openai.ts`) — the `server-only` package ships with Next.

### WP-C — Generation core (opus)

**Owns:** `lib/{openai,langsmith-openai,template-processor,content-parser,rules-schema,rules-renderer,traits,logger,guide-styles,example-guide}.ts`, `app/api/{preview,expand-style-guide,load-template,generate-styleguide}/**`, `templates/**`, new `lib/{brand-input,llm-json,markdown-format}.ts`.

**Fixes:** AI-5, 6, 7, 8, 9, 11, 13, 18, 19, 20, 23, 24, 25, 27, 28; SIMP-8, 9, 10, 12, 13, 15, 16; D3 (delete `generate-styleguide` and `load-template` + the HTTP template fallback).

**Spec:**
- Keep exported function names used outside WP-C stable (`generateKeywords`, `generateTraitSuggestions`, `generateWithOpenAI`, `generateBrandSummary` etc. used by `extract-website`). New exports are fine.
- `formatMarkdownContent` no longer runs on rule output; it must never change times, URLs, or create H2s (AI-5).
- `renderFullGuideFromPreview` returns `{ markdown, failedSections }`; failed sections keep their placeholder. `expand-style-guide` returns 502 with the failed section names and saves nothing if any failed; uses optimistic concurrency on `updated_at` (409 on conflict); `maxDuration`; rate limit; uses `requireUser({ requirePaid: true })` and `hasUnlockPlaceholders`.
- `preview`: zod-validated input (`lib/brand-input.ts`), rate limit by user/IP, `maxDuration`, effective tier via `lib/tiers`.
- LLM JSON: JSON mode for JSON calls, treat `finish_reason === "length"` as failure, one validation retry, linear `extractJson`, one shared OpenAI client with `timeout` and SDK retries (drop the hand-rolled immediate retry loop).
- `fillTemplate()` with function replacers (AI-18). Brand-voice extraction via content-parser (AI-7). Contact section id fix (AI-20). Trait suggestions filtered to the allowed list (AI-25).
- No PII in logs (AI-23).

### WP-D1 — Guide page, editor and exports (opus)

**Owns:** `app/guide/**`, `components/{GuideView,GuideLayout,GuideSidebar,GuideCover,ContentGate,MarkdownRenderer,PostExportPrompt,TraitCard,VoiceTraitSelector,BrandBanner,ExampleGuideSidebar}.tsx`, `components/editor/{GuideEditor.tsx,transforms.ts}`, `components/dashboard/{AutoSaveGuide,NewGuideButton}.tsx`, `hooks/use-guide.ts`, new `hooks/use-autosave.ts`, new `lib/{export-markdown,editor-merge,guide-files}.ts`, `lib/file-generator.ts`, `app/example/**`.

**Fixes:** FE-2, 3, 4, 5, 6, 7, 11, 15, 16, 20; AI-17; FE SIMP-1 (guide-page part), SIMP-4 (its files), SIMP-6, 9, 11; lint errors in `app/guide/page.tsx`.

**Spec:**
- Delete the full-access flow from the guide page (D3): `generateStyleGuide`, `alreadyGenerated`, regenerate dialog, retry/error blocks, `savedToAccount`, `subscriptionSuccess` loop, dead localStorage keys. `/guide` with no `guideId` and no stored preview redirects to `/`.
- Split the page: `use-autosave` (debounce, flush on unmount with `keepalive`, abort previous request, real plan type, status), export hook/module using `lib/export-markdown.ts` and `downloadFile`, components for progress and dialogs. Target: page under ~600 lines.
- `use-guide`: tier from `/api/load-style-guide` or a fresh fetch per mount; use `isUnlocked` from `lib/tiers`; "Add section" goes through the content-change path.
- `AutoSaveGuide`/claim: on 403 tell the user (toast/nudge) and stop retrying.
- Handle the new API contracts: `expand-style-guide` 502 `{ failedSections }`, 409; `create-subscription-session` 409 `{ manageUrl }` (open the portal URL) or 409 `{ upgrade: true }` (call `POST /api/change-plan`).
- Editor list transforms use classic list plugins (FE-11). Links: only `http(s):`/`mailto:` (FE-16).
- DOCX: valid numbering config and real tables (AI-17).

### WP-D2 — Auth pages, landing, extraction, shared client utils (sonnet)

**Owns:** `app/{sign-in,sign-up,forgot-password,reset-password,auth/claim,auth/error,page.tsx,layout.tsx,global-error.tsx}`, delete `app/{payment,demo,preview,full-access,brand-details}/**`, `components/{Header,HeaderAuth,UserMenu,AuthProvider,Footer,Logo,CreateGuideModal,MixpanelProvider,BreadcrumbSchema,testimonials-section,theme-provider}.tsx`, `components/landing/**`, `hooks/{use-extraction,use-toast,use-mobile}.ts*`, `lib/{api-utils,input-utils,auth-errors,mixpanel,meta-pixel,landing-data,fonts,utils}.ts*`, new `lib/{extraction,password}.ts`.

**Fixes:** FE-1 (pages), 8, 9, 12 (moot after delete), 13, 17, 18 (moot), 19, 21, 22 (its files); AI-12, 21; FE SIMP-2, 7, 8 (sign-out), 10, 12; TS-7 (its files).

**Spec:**
- `safeRedirectPath(redirectTo, "/auth/claim")` everywhere a redirect target comes from the URL (sign-in, sign-up; the forwarded `next` too).
- `fetchWithRetry`: retry only network errors and 408/429/502/503/504, with backoff; never 4xx; respect the caller's `AbortSignal`.
- `detectInputType`: text with spaces is a description (AI-21).
- `lib/extraction.ts`: one `persistExtraction` (always clears old traits/keywords) and one `classifyExtractionError`, used by both `use-extraction` and `CreateGuideModal`.
- One `signOut` in `AuthProvider` that also clears app localStorage keys; `UserMenu` uses it.
- Layout: remove the hard-coded `<title>`, description, canonical and placeholder Google verification; per-page `alternates.canonical`.
- Mixpanel session replay: mask text and inputs (FE-19); no config logging.
- Shared `validatePassword` (min 8) for sign-up and reset.
- Remove needless `"use client"` from static landing sections; render testimonials on the server.

## Phase C — integration (orchestrator)

Merge WP branches, run all gates and `next build`, run an independent review (`/code-review`-style subagent) on the full diff, fix findings, update `README.md` (merge `PROJECT.md` + `PROJECT_CONTEXT.md`), commit and push.

## Phase D — second review round (orchestrator)

After the independent review, three remaining limits were closed in code:
- In-app Pro → Agency upgrade (`/api/change-plan`), so nothing depends on Stripe portal settings.
- DNS rebinding in scraping closed with `lib/safe-fetch.ts` (the checked IP is the connected IP).
- Shared rate limits across instances (`lib/rate-limit-durable.ts` + `003_rate_limits.sql`, verified on Postgres 16 under 40 parallel requests).

## Owner actions (cannot be done from code)

- Review and apply `supabase/migrations/002_security_hardening.sql` and `003_rate_limits.sql` (staging first).
- Set `WEBFLOW_WEBHOOK_SECRET` (and in Zapier) if Webflow publishing is still used.
- Set the Stripe webhook endpoint's API version to `2025-03-31.basil` (matches `lib/stripe.ts`) and subscribe it to `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`.
- No portal plan-switching setting is needed: Pro → Agency upgrades happen in-app (`POST /api/change-plan`, prorated difference charged immediately). The Stripe Billing Portal ("Manage") is only used for managing payment details and cancelling. (Optional: enabling plan switching there lets Agency users downgrade to Pro without cancelling; nothing in the app depends on it.)
- Rotate the old `ADMIN_BLOG_PASSWORD` wherever it is reused (SEC-19). The deleted `docs/SECURITY_REVIEW.md` held it in plain text, so it is still in git history.
