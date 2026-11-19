# Tone of Voice App - Product and Architecture

**Last updated:** 2026-11-19
**Domain:** toneofvoice.app (previously aistyleguide.com)
**Stack:** Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind 3, Supabase, Stripe, OpenAI, Plate.js

---

## What this product does

A SaaS app that writes a brand's tone of voice guide in a few minutes.

**Input:** a website URL or a short brand description.
**Output:** a guide with:
- 3 brand voice traits (definition, do's, don'ts)
- Audience (overview, primary, secondary)
- 25 writing rules
- Before/after examples
- Word list (preferred terms, spelling and usage, avoid terms)
- AI writing cleanup rules (all tiers)
- Up to 5 custom sections (Pro/Agency)
- Exports: PDF (server Chrome, html2pdf fallback), Word (.docx), Markdown

---

## Tiers

Limits live in one place: `lib/tiers.ts` (`TIER_LIMITS`). Server routes, the database trigger and UI copy all use it.

| Tier | Saved guides | Access |
|------|--------------|--------|
| Starter (free) | 1 | Preview sections; paid sections locked |
| Pro | 2 | Full guide, AI editing, custom sections |
| Agency | 99 | Everything in Pro |

A paid tier only counts while the Stripe subscription is not lapsed (`effectiveTier`). `past_due`, `unpaid`, `cancelled` and similar statuses fall back to Starter.

---

## User flows

### 1. Preview (anonymous or signed in)
1. The home page hero (or the dashboard's "New guide" modal) takes a URL or description.
2. `POST /api/extract-website` scrapes the site with Cheerio (SSRF-safe, see below) and asks OpenAI for the brand name, description, audience, keywords and suggested traits.
3. `lib/extraction.ts` stores the result in `localStorage` and stamps the draft time.
4. `/guide?generate=preview` calls `POST /api/preview`, which writes the free sections and leaves `_Unlock to see …_` placeholders for paid ones.

### 2. Sign up and claim
After sign-in, `/auth/claim` and `AutoSaveGuide` save the pending draft (`lib/pending-draft.ts`) to the account. Drafts older than 24 hours are dropped, so a shared browser never hands one visitor's draft to another. Sign-out clears all draft keys.

### 3. Subscribe and expand
1. `POST /api/create-subscription-session` starts Stripe Checkout. A Pro user choosing Agency gets `409 { upgrade: true }` and, after confirming, `POST /api/change-plan` swaps the plan in place (prorated). Other existing subscribers get `409 { manageUrl }` (billing portal).
2. Stripe calls `POST /api/webhook`; `lib/stripe.ts#applySubscriptionToProfile` writes the plan. `/dashboard?subscription=success&session_id=…` also calls `POST /api/verify-subscription` as a fallback.
3. On a saved guide, "Generate full guide" calls `POST /api/expand-style-guide`. It fills only the placeholder sections, keeps placeholders for any section that failed (`502 { failedSections }`), and refuses to overwrite a guide that changed meanwhile (`409`).

### 4. Edit and export
- `/guide?guideId=…` loads from the database. Plate.js editor; edits autosave with a 2 s debounce and flush on leave (`hooks/use-autosave.ts`).
- AI editing (Cmd+J) uses `POST /api/ai/command`, paid tiers only. Starters see an upgrade dialog.
- Exports: `lib/export-markdown.ts` (Markdown), `lib/file-generator.ts` (Word), `POST /api/export-pdf` (signed-in users) with html2pdf in the browser as the fallback.

---

## Architecture

### Directory map

| Path | What it holds |
|------|---------------|
| `app/` | Pages and route handlers. `/guide` is split into `_hooks/` and `_components/`. |
| `app/api/` | Route handlers (see below). |
| `components/` | App components; `components/ui/` holds shadcn and Plate UI pieces; `components/editor/` the editor. |
| `hooks/` | Shared client hooks (`use-guide`, `use-autosave`, `use-extraction`, `use-toast`). |
| `lib/` | Pure logic and server modules. Every module with logic has a `*.test.ts` next to it. |
| `proxy.ts` | Next 16 proxy (was `middleware.ts`): refreshes the Supabase session on pages, guards `/dashboard`. |
| `supabase/migrations/` | Database migrations. |
| `templates/style_guide_template.md` | Guide template. |
| `test/` | Test setup and shared fakes. |

### API routes

| Route | Auth | Purpose |
|-------|------|---------|
| `extract-website` | none, rate limited | Scrape + extract brand details |
| `preview` | optional, rate limited | Generate preview sections |
| `expand-style-guide` | paid | Generate the locked sections of a saved guide |
| `save-style-guide` / `load-style-guide` / `delete-style-guide` | user | Guide storage (owner only; limit enforced) |
| `user-guide-limit` / `user-subscription-tier` | user | Tier and usage for the UI |
| `create-subscription-session` / `change-plan` / `create-portal-session` / `verify-subscription` | user | Stripe (checkout, in-app upgrade, portal, post-checkout sync) |
| `webhook` | Stripe signature | Subscription events (deduped, retried on failure) |
| `ai/command` | paid, rate limited | Plate.js AI commands (model fixed on the server) |
| `export-pdf` | user, rate limited | Server PDF (JavaScript off, network locked down) |
| `post-to-webflow` | shared secret | Zapier to Webflow blog publishing |
| `cron/keep-alive` | `CRON_SECRET` | Keeps Supabase awake |

Shared route helpers: `lib/api-auth.ts` (`requireUser`, `withRouteErrors`, `tooManyRequests`) and `lib/rate-limit-durable.ts` (`checkRateLimit`: shared Postgres counter from migration 003, falling back to the in-memory `lib/rate-limit.ts`).

### Security notes
- `lib/url-validation.ts#assertPublicHttpUrl` blocks private, loopback, link-local and metadata addresses (including DNS answers). The scraper fetches through `lib/safe-fetch.ts`, which validates the IP the socket actually connects to (no DNS rebinding), re-checks every redirect and only follows same-site links.
- Redirect targets from URLs go through `lib/safe-redirect.ts`.
- Server-only modules (`openai`, `stripe`, `supabase-admin`, scraper, PDF) import `server-only`, so a client import fails the build.
- `supabase/migrations/002_security_hardening.sql` adds RLS, column privileges, the guide-limit trigger and the Stripe event table; `003_rate_limits.sql` adds shared rate-limit counters. Review them before applying.

### AI
- Extraction and generation: `gpt-5.2` through one shared OpenAI client (`lib/langsmith-openai.ts`, 60 s timeout, SDK retries). JSON answers are validated and retried once (`lib/llm-json.ts`).
- Editor AI: `gpt-5-mini` via the Vercel AI SDK v5.
- LangSmith tracing is optional (`docs/LANGSMITH-SETUP.md`).

### Design system
Typography tokens are in `lib/guide-styles.ts`; see `docs/DESIGN_SYSTEM.md`.

---

## Guide content rules

- **Audience:** Overview (1 sentence), Primary (2 short paragraphs), Secondary (1 paragraph). No writing advice.
- **Word list order:** Preferred Terms, Spelling and Usage, Avoid Terms (two-column tables).
- **No em dashes** in generated content or UI copy.
- **Brand description:** 80-120 words, outcome-focused, no buzzwords.
- **Custom sections:** up to 5, titles up to 60 characters, inserted before "Questions?".

---

## Environment

See `.env.example` for every variable and what it is for.

---

## Development

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm test         # Vitest (unit, route and component tests)
pnpm typecheck    # tsc --noEmit
pnpm lint         # ESLint (flat config)
pnpm build        # Production build (type errors fail the build)
```

Prompt-quality scripts (need `OPENAI_API_KEY`, some need a running dev server):

```bash
node scripts/test-audience-prompt.mjs --url https://stripe.com
node scripts/test-style-rules.mjs
node scripts/test-style-rules-detailed.mjs
```

### Debugging
| Issue | Check |
|-------|-------|
| Auth errors | Supabase URL/keys, RLS policies |
| Paid user shows as Starter | `profiles.subscription_status`; Stripe webhook deliveries |
| PDF export fails | Chromium binary on the host; the client falls back to html2pdf |
| 429 responses | Limits in each route; counters in `public.rate_limits` (or in memory before migration 003) |

---

## History

- `docs/audit/` - November 2026 audit, plan and findings.
- `docs/RELEASE-NOTES-*.md` - release notes.
