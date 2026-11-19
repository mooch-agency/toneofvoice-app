# 04 - Dependencies, tooling, editor kit, dead code, repo hygiene

Scope: package.json, build/tooling config, components/editor/**, components/ui/**, dead code, repo hygiene.
Method: `npx tsc --noEmit` baseline (148 errors), custom import-graph walker (scratchpad `graph.mjs`, entries = app/**/{page,layout,route,loading,error,global-error,not-found,...}.tsx?, middleware.ts, tailwind/next config; regex-based resolution of `@/` and relative imports incl. `import()` and `require()`), per-dependency import scan (`depuse.mjs`), read-only commands only. Raw outputs: `unreach.tsv`, `dead.txt`, `err-dead.txt`, `err-live.txt` next to this file.
Graph: 380 source files scanned, 229 reachable, 141 unreachable (138 deletable; the other 3 are `postcss.config.mjs`, `vitest.config.mts`, `lib/cheerio-site-scraper.test.ts`, which are tooling/tests and picked up by tools, not by imports).
Limits: regex graph does not see string-built paths or `next/dynamic` with computed specifiers; I grepped for those (none found for the delete list). Verified `import()` is handled.

## Headline

* 105 of the 148 TS errors (71%) are in files nothing imports. Deleting dead code removes them. The 43 remaining are in 14 live files; ~8 are genuine runtime-relevant bugs.
* The whole "Plate playground" kit (`editor-kit.tsx` + 35 plugin kits + ~89 `components/ui` files, ~17.4k LOC) is dead: `GuideEditor.tsx` assembles its own plugin list and never imports `editor-kit.tsx`. Every missing-package TS error (uploadthing, excalidraw, @platejs/dnd, emoji, etc.) lives in that dead tree.
* `typescript.ignoreBuildErrors: true` hides the 43 live errors; `pnpm lint` is broken (no ESLint installed, `next lint` removed).
* All 10 `package.json` script targets for `scripts/*.js` are missing from disk.

---

## 1. TypeScript errors (TS-n)

Totals by code: TS2307 x60 (missing module), TS7031 x21 + TS7006 x19 (implicit any, cascade from missing modules), TS2339 x20, TS2322 x8, TS2769 x6, TS2345 x5, TS2353 x4, TS2305 x2, others 4.

| Group | Errors | Files | Category | Root cause | Fix |
|---|---|---|---|---|---|
| TS-1 | 105 | 36 | (a)+(b) dead | Dead Plate playground files; 32 distinct uninstalled packages (`@platejs/dnd`, `@platejs/emoji`, `@platejs/resizable`, `@platejs/code-drawing`, `@platejs/excalidraw`, `@platejs/docx(-io)`, `@platejs/autoformat`, `@platejs/combobox`, `@platejs/slash-command`, `@platejs/juice`, `uploadthing`, `@uploadthing/react`, `use-file-picker`, `react-dnd(-html5-backend)`, `react-player`, `react-tweet`, `react-lite-youtube-embed`, `react-textarea-autosize`, `html2canvas-pro`, `pdf-lib`, `@emoji-mart/data`, `@ariakit/react`, `lodash/debounce`), plus 2 `insertInlineElement` export-gone errors and a cascade of implicit-any (TS7006/7031) from the unresolved imports. | Delete the files (section 6 list). Do NOT install the packages. |

TS-1 files (errors): components/editor/plugins/autoformat-kit.tsx(10) components/editor/plugins/code-drawing-base-kit.tsx(1) components/editor/plugins/code-drawing-kit.tsx(1) components/editor/plugins/dnd-kit.tsx(7) components/editor/plugins/docx-kit.tsx(2) components/editor/plugins/emoji-kit.tsx(2) components/editor/plugins/excalidraw-kit.tsx(1) components/editor/plugins/slash-kit.tsx(2) components/ui/block-context-menu.tsx(1) components/ui/block-draggable.tsx(3) components/ui/block-selection.tsx(1) components/ui/callout-node.tsx(1) components/ui/code-drawing-node-static.tsx(1) components/ui/code-drawing-node.tsx(5) components/ui/column-node.tsx(4) components/ui/emoji-node.tsx(3) components/ui/emoji-toolbar-button.tsx(7) components/ui/equation-node.tsx(1) components/ui/excalidraw-node.tsx(2) components/ui/export-toolbar-button.tsx(4) components/ui/font-color-toolbar-button.tsx(1) components/ui/import-toolbar-button.tsx(5) components/ui/inline-combobox.tsx(8) components/ui/insert-toolbar-button.tsx(2) components/ui/media-audio-node.tsx(1) components/ui/media-embed-node.tsx(3) components/ui/media-file-node.tsx(1) components/ui/media-image-node.tsx(2) components/ui/media-placeholder-node.tsx(2) components/ui/media-toolbar-button.tsx(2) components/ui/media-video-node.tsx(4) components/ui/resize-handle.tsx(1) components/ui/slash-node.tsx(2) components/ui/table-node.tsx(5) hooks/use-upload-file.ts(4) lib/uploadthing.ts(3) 

Verified: every file in TS-1 is absent from the reachable set, and every package in the "missing" list is imported only by unreachable files (`depuse.mjs` "MISSING" section: 0 non-dead importers each).

### Live-file errors (43 errors, 14 files)

* **TS-2 (HIGH, real bug)** `middleware.ts:5` (2 errors). `lib/supabase-middleware.ts#updateSession` returns a bare `NextResponse` when Supabase env vars are missing (line 13) but `{supabaseResponse, user}` otherwise; middleware destructures unconditionally, so with missing env `supabaseResponse`/`user` are undefined and middleware returns `undefined`. Fix: always return the object shape. Also Next 16 renamed the `middleware` file convention to `proxy` (still works, deprecated).
* **TS-3 (HIGH, real bug)** `app/api/webhook/route.ts` (5), `app/api/verify-subscription/route.ts` (2): `current_period_end`. Installed `stripe@18.0.0` types target API `2025-03-31.basil`, where `current_period_end` moved from Subscription to `items.data[]`; code pins `apiVersion: "2023-10-16"` (5 call sites, 4 via `as Stripe.LatestApiVersion` cast, webhook has no cast -> TS2322). Runtime is OK for API-originated calls (pinned version returns the old shape) but webhook event payloads use the webhook endpoint's configured API version, so `sub.current_period_end` can silently be `undefined` (webhook lines 85-86, 180-181) and `current_period_end` is stored as null. Fix: read `sub.items.data[0].current_period_end` with fallback, centralise one `lib/stripe.ts` client, pick one apiVersion.
* **TS-4 (MED)** `app/api/ai/command/route.ts` (12) + `components/editor/use-chat.ts` (1) + `components/ui/ai-menu.tsx` (2). Likely root cause: dependency skew. Root `ai@5.0.28` but `@ai-sdk/react@3.0.88` depends on `ai@6.0.86` (pnpm store holds both `ai@5.0.28` and `ai@6.0.86`; `@platejs/ai@52.1.0` types its writer as `{write(part:{data:unknown;type:string})}`). `UIMessageStreamWriter<ChatMessage>` is not assignable and `id` is rejected on parts; `ChatOnDataCallback` mismatch. Fix: align `ai` and `@ai-sdk/react` (both v5: `@ai-sdk/react@^2`, `@ai-sdk/openai@^2` is v5-compatible; or move all to v6 with `@ai-sdk/openai@^3`), then re-run tsc. ai-menu.tsx (`'subscriptionTier'` not a typed AIChatPlugin option; GuideEditor.tsx:200 already uses `as any`): extend plugin options type or cast.
* **TS-5 (MED, real type bug)** `app/api/extract-website/route.ts` (11): `.content` read on union `GenerationResult | {success:false,error}` without narrowing (lines 154-163, 329-336) and `unknown` errors passed to a logger expecting `Error` (186, 208, 359). Needs `if (!result.success)` narrowing / `error instanceof Error`.
* **TS-6 (LOW)** `app/api/generate-styleguide/route.ts:3` imports `captureServerError` from `@/lib/posthog`, which was deleted in commit 484f814 (PostHog -> Mixpanel, 2026-03-13). The symbol is never used in the file (grep: only the import line), so SWC strips it and the build survives; it is a stale leftover. Fix: delete the line (and consider adding Mixpanel/server logging if error capture was intended).
* **TS-7 (LOW)** `lib/firecrawl-site-scraper.ts` (2, "No overload matches" at lines 170/191, probable Firecrawl v4 option shape change), `lib/logger.ts:22` (`error` optional vs LogEntry), `lib/mixpanel.ts:14` (`__loaded` not in types), `components/MarkdownRenderer.tsx:50` (unknown), `components/landing/hero-section.tsx:120` (void tested for truthiness: a `if (await fn())` on a function returning void -> condition always false, real logic bug), `components/ui/heading-node.tsx:51` (`variant='h1'` default not in cva variants -> h1 gets no class; real styling bug).

Summary: (a) dead files = 105 errors; (b) missing deps = 60 TS2307 + 2 TS2305, all inside (a); (c) real/live = 43. Deleting TS-1 and fixing TS-2..7 brings tsc to 0 and allows removing `ignoreBuildErrors`.

---

## 2. Dead code (DEAD-n)

* **DEAD-1 (HIGH, conf 95%)** `components/editor/editor-kit.tsx` (and its 35 plugin kits + ~89 ui files) is unreachable. Evidence: `grep -rn "editor-kit" app components hooks lib` shows only `editor-base-kit` (live, from `/api/ai/command` and via ai-chat-editor dead) and `editor-kit.tsx` itself; `GuideEditor.tsx` imports only `ai-kit`, `suggestion-ai-kit`, `floating-toolbar-kit` from plugins. Last touched 2026-02-16.
* **DEAD-2 (HIGH, 95%)** Live editor plugin files (keep): ai-kit, suggestion-ai-kit, floating-toolbar-kit, cursor-overlay-kit, markdown-kit and all `*-base-kit` (used by `editor-base-kit`, which server route `/api/ai/command` uses). Everything else under `plugins/` is dead (35 files).
* **DEAD-3 (HIGH, 95%)** Dead app components: `GuideAccordion.tsx`, `GuideHeader.tsx`, `company-logos-section.tsx` (zero importers each).
* **DEAD-4 (HIGH, 95%)** Dead hooks: `use-debounce.ts`, `use-is-touch-device.ts`, `use-mounted.ts`, `use-upload-file.ts` (imports uninstalled `uploadthing`).
* **DEAD-5 (HIGH, 95%)** Dead lib: `blog-prompts.js` + `lib/prompts/*.md` (only consumer is the deleted blog scripts; no blog route exists in app/), `firecrawl.js` (superseded by `firecrawl-site-scraper.ts`), `markdown-joiner-transform.ts`, `supabase.ts` (legacy Proxy client + EmailCapture type; replaced by supabase-browser/server/admin), `uploadthing.ts`, `url-utils.ts`. Confirm `lib/prompts/` has no runtime reader: `grep "prompts/" app lib components` only hits `app/api/ai/command/prompt/*` (different dir) and the comment in blog-prompts.js.
* **DEAD-6 (MED)** `styles/globals.css` (2.4KB) is a stale duplicate; `app/layout.tsx` imports `./globals.css` (app/globals.css, 12KB). No reference to `styles/`. tailwind content globs should be checked before deleting the dir (they list paths; `styles/` only has this file).
* **DEAD-7 (MED)** `components/ui/*` shadcn primitives with zero importers (library-style; deleting is compile-safe, optional if you want them for future): accordion, aspect-ratio, breadcrumb, carousel, chart, collapsible, drawer, form, hover-card, input-otp, menubar, navigation-menu, pagination, radio-group, resizable, scroll-area, slider, sonner, switch, table, toggle-group, toggle, calendar, checkbox, context-menu, alert-dialog, clean-minimal-sign-in, use-mobile, use-toast. Deleting them also removes ~15 `@radix-ui/*` + recharts/embla/vaul/etc. deps (section 4).
* **DEAD-8 (INFO)** `app/api/page.tsx` is a UI page under `/api` (route `/api`, imports use-toast); `app/api/test-email/route.ts` has no auth or NODE_ENV guard: anyone can POST `{email}` and send a "thank you" email through Resend (abuse/spam vector, hygiene+security). Recommend delete or guard. `app/demo/page.tsx` also looks like a leftover: confirm intent.
* **DEAD-9 (INFO)** `postcss.config.mjs` contains only `tailwindcss` and relies on nothing else; `autoprefixer` in deps is therefore unused by config (Tailwind 3 + Next handle it; see DEP).

---

## 3. Duplicates (DUP via DEAD/HYG ids)

* **HYG-1 (MED, verified)** `hooks/use-toast.ts` and `components/ui/use-toast.ts` are the same shadcn toast hook (diff verified: the two files are identical, `diff` reported no difference). All live code imports `@/hooks/use-toast` (7 files + `components/ui/toaster.tsx`); `components/ui/use-toast.ts` has zero importers -> delete it. Duplicated *state* risk: none today because only one is imported.
* **HYG-2 (MED, verified)** `hooks/use-mobile.tsx` (exports `useMobile` + alias `useIsMobile`) vs `components/ui/use-mobile.tsx` (`useIsMobile`, 768px). Live code (`sidebar.tsx`, `code-drawing-node.tsx`) imports `@/hooks/use-mobile`; `components/ui/use-mobile.tsx` has zero importers -> delete.
* **HYG-3 (MED, verified)** Two toast systems: Radix toast (`components/ui/toast.tsx` + `toaster.tsx` mounted in `app/layout.tsx:345`, hook `hooks/use-toast`) is live. Sonner (`components/ui/sonner.tsx` Toaster is never mounted; `toast` imported from `sonner` only in `hooks/use-upload-file.ts`, `media-toolbar-button.tsx`, `media-upload-toast.tsx`, all dead). Sonner is therefore never rendered. Remove `sonner` + `components/ui/sonner.tsx`.
* **HYG-4 (LOW)** Duplicate Stripe client construction in 5 routes with `apiVersion: "2023-10-16"` (webhook differs, no cast); centralise.

---

## 4. package.json (DEP-n)

Versions installed: next 16.1.6, react 19.1.0, ai 5.0.28, @ai-sdk/react 3.0.88 (pulls ai 6.0.86), @ai-sdk/openai 2.0.91, openai 4.99.0, stripe 18.0.0, zod 4.3.6, platejs 52.0.17, typescript 5.8.3. No ESLint is installed (`ls node_modules/.bin | grep eslint` empty).

* **DEP-1 (HIGH)** `"lint": "next lint"`: Next 16 removed the command; running `npx next lint` returns "Invalid project directory provided, no such directory: .../lint" (it treats `lint` as a directory). `eslint` key in next.config.js is also gone in Next 16 (`grep eslint node_modules/next/dist/server/config-shared.d.ts` empty). Options: (a) remove the script; (b) add flat config:
  ```
  pnpm add -D eslint eslint-config-next
  // eslint.config.mjs
  import { defineConfig, globalIgnores } from "eslint/config";
  import next from "eslint-config-next";
  import vitals from "eslint-config-next/core-web-vitals";
  import ts from "eslint-config-next/typescript";
  export default defineConfig([...vitals, ...ts, globalIgnores([".next/**","scripts/**"])]);
  // package.json: "lint": "eslint ."
  ```
  (Next 16 docs form; check exports of the installed eslint-config-next version when adding.)
* **DEP-2 (HIGH)** `"fs": "latest"` and `"path": "latest"`: Node built-ins; `node_modules/fs -> fs@0.0.1-security` (npm security placeholder) and `node_modules/path -> path@0.12.7` (browser polyfill). Source uses `import fs from "fs"` in `app/api/load-template/route.ts` (server, resolves to builtin) and dead `lib/blog-prompts.js`. Remove both; a bundler could resolve the npm `path` over the builtin in client bundles. Supply-chain risk because of `latest`.
* **DEP-3 (MED)** `"jspdf": "latest"`, `"jspdf-autotable": "latest"`: zero imports anywhere (src, scripts). Remove. `html2pdf.js` is USED (dynamic `import("html2pdf.js")` in app/guide/page.tsx:825 with `@ts-expect-error`) and bundles its own jspdf; keep, pin.
* **DEP-4 (MED)** `@radix-ui/react-collapsible`, `-label`, `-progress`: `"latest"` pins; others are exact pins (1.1.4) mixed with carets. Pin or caret consistently. Of these, label and progress are live, collapsible dead.
* **DEP-5 (MED)** `openai@^4.99` and `@ai-sdk/openai@^2`: both used, not redundant today. `openai` SDK in 5 live files (ai-assist, rewrite-section, lib/openai.ts, langsmith-openai.ts, template-processor) + 4 scripts; `@ai-sdk/openai` only in `app/api/ai/command/route.ts`. Two OpenAI client stacks, two key reads. Consolidation option: migrate to AI SDK (`generateText`). Note `ai`/`@ai-sdk/react` skew (TS-4).
* **DEP-6 (HIGH)** `ai@^5` vs `@ai-sdk/react@^3` skew creates two copies of `ai` (5.0.28 and 6.0.86) in the tree (see TS-4).
* **DEP-7 (LOW)** `react-dom` has no direct import but is required by react/next (peer); keep. `sharp`: no direct import; Next 16 uses it automatically for image optimisation on self-hosted; harmless/keep (Vercel supplies its own). `@types/node@^22` vs Node 22 Dockerfile ok. `zod@^4` with platejs/ai SDK ok.
* **DEP-8 (LOW)** `dotenv` is only used by scripts (8 files in scripts/); move to devDependencies or drop with scripts. `to-ico` (devDep) and `ts-node` devDeps: no references (the scripts that used `to-ico` are gone).
* **DEP-9 (LOW, missing)** `lodash` is imported by dead `code-drawing-node.tsx`, `font-color-toolbar-button.tsx` but not declared; only dead code => no action once deleted.

### Explicit unused-dependency list

Zero imports anywhere (src, config, scripts), verified with `depuse.mjs` and manual grep:
`@hookform/resolvers`, `@stripe/stripe-js`, `autoprefixer` (postcss.config.mjs only configures tailwindcss), `geist` (layout uses `next/font/google` Geist; `geist` package unused), `jspdf`, `jspdf-autotable`, `react-jsx-parser`, `styled-components`, `turndown`, `@types/turndown`, `fs`, `path`, `to-ico`, `ts-node`.
(`dotenv`: scripts only; `react-dom`, `sharp`, `postcss`, `@types/*`, `typescript` are implicit/tool deps, keep.)

Used only by dead code (becomes unused after the delete list in section 6 is applied):
`sonner`, `react-hook-form`, `recharts`, `embla-carousel-react`, `vaul`, `input-otp`, `react-day-picker`, `react-resizable-panels`, `@radix-ui/react-accordion`, `-alert-dialog`, `-aspect-ratio`, `-checkbox`, `-collapsible`, `-context-menu`, `-hover-card`, `-menubar`, `-navigation-menu`, `-radio-group`, `-scroll-area`, `-slider`, `-switch`, `-toggle`, `-toggle-group`.
Caveat: `@platejs/list-classic`, `@platejs/layout`, etc. are used by live base kits; I did not mark any `@platejs/*` unused.
Used by tooling only (keep): vitest, jsdom, @vitejs/plugin-react, vite-tsconfig-paths (vitest.config.mts), tailwind plugins (tailwindcss-animate, @tailwindcss/typography, tailwind-scrollbar-hide in tailwind.config.ts).

---

## 5. Config (CFG-n)

* **CFG-1 (HIGH)** `typescript.ignoreBuildErrors: true` hides 43 live errors including the Stripe, middleware and AI route bugs above. Remove after fixing TS-2..7.
* **CFG-2 (HIGH)** `env: { OPENAI_API_KEY, STRIPE_PUBLISHABLE_KEY, NEXT_PUBLIC_APP_URL }` in next.config.js. The `env` block inlines values at build time into every bundle that references `process.env.X`. Checked: no `"use client"` file reads `process.env.OPENAI_API_KEY` today (all 5 readers are server routes/lib), so no leak currently, but one future client import would ship the secret to browsers; also it freezes values at build. Delete the block (server code reads runtime env; `NEXT_PUBLIC_*` is automatic; `STRIPE_PUBLISHABLE_KEY` is read nowhere, grep empty).
* **CFG-3 (MED)** `images.remotePatterns` includes `hostname: '**'` over https (makes `vercel.com` entry redundant); lets the optimiser proxy any https image (SSRF-ish/bandwidth abuse). Restrict to real hosts (Supabase storage, etc.).
* **CFG-4 (MED)** `eslint: { ignoreDuringBuilds }` is dead config in Next 16. Remove.
* **CFG-5 (LOW)** tsconfig `target: "ES6"`; Next recommends ES2017+ (async/await, object spread emitted natively; matters for tsc diagnostics and `incremental`). Set `"ES2017"`. `include` references `.next/dev/types/**` (valid for Next 16). `tsconfig.tsbuildinfo` exists locally but is gitignored (ok).
* **CFG-6 (LOW)** `vitest.config.mts` is fine: `setupFiles ./test/setup.ts` exists (`ls test` = setup.ts), `pnpm test` verified: 1 file, 4 tests pass (12s, two tests wait on real 3-5s timeouts). Only one test file in the repo; coverage minimal. Note include `**/*.test.{ts,tsx}` also scans scripts/.
* **CFG-7 (LOW)** `vercel.json`: aistyleguide.com redirects + cron `/api/cron/keep-alive` exist (route exists). Middleware matcher excludes `api/webhook` only; `/api/test-email` is reachable unauthenticated (DEAD-8). Middleware file convention is deprecated in Next 16 (`proxy.ts`).
* **CFG-8 (LOW)** `.gitignore`: `.env*` ignores `.env.example` too (no example env file exists anywhere; README says see CLAUDE.md which is deleted -> there is no env documentation at all). Add `!.env.example` and create one. `next-env.d.ts` and `*.tsbuildinfo` ignored (fine). `scripts/output/` ignored.

---

## 6. Repo hygiene (HYG-n)

* **HYG-5 (HIGH, verified)** ALL 14 `package.json` script entries (10 distinct files) point to missing files: `generate-blog` (+`:dry`, `:limit`) -> scripts/generate-blog-posts.js; `convert-search-terms`; `update-post-images`; `update-blog-images`; `test-outline`; `test:style-guide-gen`; `generate-logos`; `generate-favicons`; `generate-og-image`; `generate-icons` (chains logos+favicons); `generate-preview-pdf`. `ls scripts/` holds only check-guides.mjs, check-schema.mjs, check-stripe-vercel-rebrand.mjs, setup-vercel-domain.sh, test-abbreviations.mjs, test-audience-prompt.mjs, test-style-rules*.mjs, update-email-templates.sh, update-stripe-*.mjs, update-supabase-email-templates.mjs, update-vercel-env.sh. Delete the 14 dead script entries (generate-blog x3 variants, convert-search-terms, update-post-images, update-blog-images, test-outline, test:style-guide-gen, generate-logos, generate-favicons, generate-icons, generate-og-image, generate-preview-pdf); the surviving one-off scripts (rebrand/stripe migration) are historical: archive or delete. Blog system is gone from app/ (no `app/blog`), so `docs/BLOG_SYSTEM_*`, `docs/end-to-end-test-output.md`, `lib/blog-prompts.js`, `lib/prompts/`, `public/blog-images/` (21 files, 9.4MB, zero code references) are all orphaned.
* **HYG-6 (HIGH)** README.md is stale: says "Next.js 15.2" (actual 16.1.6), points to `CLAUDE.md` (removed in commit 2ed166a "remove project CLAUDE.md") twice for env var docs, and to `DESIGN_SYSTEM.md` at repo root (it lives at `docs/DESIGN_SYSTEM.md`). No `.env.example` -> env vars undocumented.
* **HYG-7 (MED)** `PROJECT.md` (294 lines, "Last Updated 2026-02-18", Next 15) and `PROJECT_CONTEXT.md` (295 lines, 2026-03-05, Next 15) overlap ~entirely (diff 555 lines but both are product-spec/context of same app). Both reference `DESIGN_SYSTEM.md` at root and `lib/style-guide-styles.ts` (does not exist; real file is `lib/guide-styles.ts`). Merge into one (README or docs/PROJECT.md) and fix paths/versions.
* **HYG-8 (MED)** `docs/` (21 files, 196KB): stale/planning/one-off: BLOG_SYSTEM_README, BLOG_SYSTEM_ROADMAP, end-to-end-test-output (generated 2025-11-11), FAVICON_RESEARCH, CHANGELOG-2025-02-09, FORTRESS_ROADMAP, SINGLE-EDITOR-MIGRATION-PLAN (migration done: GuideEditor is single editor), REBRAND-TONEOFVOICE (references CLAUDE.md), deslop.md, outline.md, playtime.md, EMAIL-DRAFTS-SUBSCRIPTION. Probably keep: DESIGN_SYSTEM, SECURITY_REVIEW, STRIPE-RESTRICTED-KEY-SETUP, STYLE_GUIDE_GENERATION, LANGSMITH-*, RELEASE-NOTES-*, SCHEMA_ORG_REFERENCE (review). Confidence moderate: content owner should confirm.
* **HYG-9 (LOW)** `drafts/what-will-you-do-when-you-dont-need-money.md` (blog draft, 12KB), `tasks/todo.md` + `tasks/lessons.md` (agent scratch, todo describes already-shipped /example CTA: `app/example` exists), `prompts/soundlikeme.md` (unreferenced), `.cursor/` (88KB Cursor commands, PRD, plan; but `.cursor/Dockerfile` + `environment.json` are the Cursor cloud-agent env, keep if Cursor agents still used). `.claude/launch.json` is a valid dev launcher (port 3002), keep.
* **HYG-10 (LOW, verified)** `mcp-send-email/` is an empty directory (not tracked by git; remove locally).
* **HYG-11 (LOW)** Unused public assets (zero code references): `brand-voice-guidelines.png`, `tone_of_voice_logo.png`, `wordmark.png`, `android-chrome-512x512.png` (the latter likely referenced by a manifest, which does not exist; leave), `headshot-2/3.jpg` have 1 each (used). `public/blog-images` see HYG-5.
* **HYG-12 (LOW)** Only 1 unit test file (`lib/cheerio-site-scraper.test.ts`) in a billing/AI SaaS; no CI config found in repo (no .github).

---

## 7. Explicit DELETE list (138 files)

Confidence key: HIGH = zero importers or only dead importers, graph + grep verified; for `components/ui` library primitives (marked LIB) deletion is compile-safe but you may prefer to keep generic shadcn primitives.

### 7a. HIGH confidence (109 files): dead editor kit + dependents + dead app code
- components/GuideAccordion.tsx
- components/GuideHeader.tsx
- components/company-logos-section.tsx
- components/editor/editor-kit.tsx
- components/editor/plugins/align-kit.tsx
- components/editor/plugins/autoformat-kit.tsx
- components/editor/plugins/basic-blocks-kit.tsx
- components/editor/plugins/basic-marks-kit.tsx
- components/editor/plugins/basic-nodes-kit.tsx
- components/editor/plugins/block-menu-kit.tsx
- components/editor/plugins/block-placeholder-kit.tsx
- components/editor/plugins/block-selection-kit.tsx
- components/editor/plugins/callout-kit.tsx
- components/editor/plugins/code-block-kit.tsx
- components/editor/plugins/code-drawing-base-kit.tsx
- components/editor/plugins/code-drawing-kit.tsx
- components/editor/plugins/column-kit.tsx
- components/editor/plugins/comment-kit.tsx
- components/editor/plugins/date-kit.tsx
- components/editor/plugins/discussion-kit.tsx
- components/editor/plugins/dnd-kit.tsx
- components/editor/plugins/docx-kit.tsx
- components/editor/plugins/emoji-kit.tsx
- components/editor/plugins/excalidraw-kit.tsx
- components/editor/plugins/exit-break-kit.tsx
- components/editor/plugins/fixed-toolbar-kit.tsx
- components/editor/plugins/font-kit.tsx
- components/editor/plugins/indent-kit.tsx
- components/editor/plugins/line-height-kit.tsx
- components/editor/plugins/link-kit.tsx
- components/editor/plugins/list-kit.tsx
- components/editor/plugins/math-kit.tsx
- components/editor/plugins/media-kit.tsx
- components/editor/plugins/mention-kit.tsx
- components/editor/plugins/slash-kit.tsx
- components/editor/plugins/suggestion-kit.tsx
- components/editor/plugins/table-kit.tsx
- components/editor/plugins/toc-kit.tsx
- components/editor/plugins/toggle-kit.tsx
- components/ui/ai-chat-editor.tsx
- components/ui/align-toolbar-button.tsx
- components/ui/block-context-menu.tsx
- components/ui/block-discussion.tsx
- components/ui/block-draggable.tsx
- components/ui/block-list.tsx
- components/ui/block-selection.tsx
- components/ui/block-suggestion.tsx
- components/ui/callout-node.tsx
- components/ui/caption.tsx
- components/ui/code-block-node.tsx
- components/ui/code-drawing-node-static.tsx
- components/ui/code-drawing-node.tsx
- components/ui/column-node.tsx
- components/ui/comment-node.tsx
- components/ui/comment-toolbar-button.tsx
- components/ui/comment.tsx
- components/ui/date-node.tsx
- components/ui/editor-static.tsx
- components/ui/emoji-node.tsx
- components/ui/emoji-toolbar-button.tsx
- components/ui/equation-node.tsx
- components/ui/equation-toolbar-button.tsx
- components/ui/excalidraw-node.tsx
- components/ui/export-toolbar-button.tsx
- components/ui/fixed-toolbar-buttons.tsx
- components/ui/font-color-toolbar-button.tsx
- components/ui/font-size-toolbar-button.tsx
- components/ui/highlight-node.tsx
- components/ui/import-toolbar-button.tsx
- components/ui/indent-toolbar-button.tsx
- components/ui/inline-combobox.tsx
- components/ui/insert-toolbar-button.tsx
- components/ui/kbd-node.tsx
- components/ui/line-height-toolbar-button.tsx
- components/ui/link-toolbar.tsx
- components/ui/list-toolbar-button.tsx
- components/ui/media-audio-node.tsx
- components/ui/media-embed-node.tsx
- components/ui/media-file-node.tsx
- components/ui/media-image-node.tsx
- components/ui/media-placeholder-node.tsx
- components/ui/media-preview-dialog.tsx
- components/ui/media-toolbar-button.tsx
- components/ui/media-toolbar.tsx
- components/ui/media-upload-toast.tsx
- components/ui/media-video-node.tsx
- components/ui/mention-node.tsx
- components/ui/mode-toolbar-button.tsx
- components/ui/more-toolbar-button.tsx
- components/ui/resize-handle.tsx
- components/ui/slash-node.tsx
- components/ui/suggestion-node.tsx
- components/ui/suggestion-toolbar-button.tsx
- components/ui/table-icons.tsx
- components/ui/table-node.tsx
- components/ui/table-toolbar-button.tsx
- components/ui/toc-node.tsx
- components/ui/toggle-node.tsx
- components/ui/toggle-toolbar-button.tsx
- hooks/use-debounce.ts
- hooks/use-is-touch-device.ts
- hooks/use-mounted.ts
- hooks/use-upload-file.ts
- lib/blog-prompts.js
- lib/firecrawl.js
- lib/markdown-joiner-transform.ts
- lib/supabase.ts
- lib/uploadthing.ts
- lib/url-utils.ts

### 7b. LIB primitives (29 files), safe to delete (compile-safe; also frees the radix/recharts deps in section 4)
- components/ui/accordion.tsx
- components/ui/alert-dialog.tsx
- components/ui/aspect-ratio.tsx
- components/ui/breadcrumb.tsx
- components/ui/calendar.tsx
- components/ui/carousel.tsx
- components/ui/chart.tsx
- components/ui/checkbox.tsx
- components/ui/clean-minimal-sign-in.tsx
- components/ui/collapsible.tsx
- components/ui/context-menu.tsx
- components/ui/drawer.tsx
- components/ui/form.tsx
- components/ui/hover-card.tsx
- components/ui/input-otp.tsx
- components/ui/menubar.tsx
- components/ui/navigation-menu.tsx
- components/ui/pagination.tsx
- components/ui/radio-group.tsx
- components/ui/resizable.tsx
- components/ui/scroll-area.tsx
- components/ui/slider.tsx
- components/ui/sonner.tsx
- components/ui/switch.tsx
- components/ui/table.tsx
- components/ui/toggle-group.tsx
- components/ui/toggle.tsx
- components/ui/use-mobile.tsx
- components/ui/use-toast.ts

Note: `components/ui/use-mobile.tsx` and `components/ui/use-toast.ts` are exact duplicates of live hooks (HIGH confidence even though listed in 7b). `calendar`, `checkbox`, `context-menu`, `alert-dialog`, `toggle`, `clean-minimal-sign-in` are only imported by other dead files.

### 7c. Non-code deletions (MED confidence unless noted)
- `styles/globals.css` (stale duplicate)
- `mcp-send-email/` (empty dir, HIGH)
- `public/blog-images/` (9.4MB, 21 images, zero references) and the blog docs `docs/BLOG_SYSTEM_README.md`, `docs/BLOG_SYSTEM_ROADMAP.md`, `docs/end-to-end-test-output.md`
- the 14 dead script entries in package.json (HYG-5)
- `drafts/`, `tasks/`, `prompts/soundlikeme.md` (owner confirm)
- one of `PROJECT.md`/`PROJECT_CONTEXT.md` after merge

### Keep (tool-picked, not import-reachable)
`postcss.config.mjs`, `vitest.config.mts`, `lib/cheerio-site-scraper.test.ts`.

After deletion, re-run `npx tsc --noEmit` (expect 43 errors, all in live files) and `npx vitest run` (expect 4 pass). I did not run `next build` (would write to `.next`), so build-level confirmation of the delete list is outstanding; recommend running it on a branch.
