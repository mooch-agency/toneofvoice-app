# Release notes - November 2026

A full audit of the codebase (see `docs/audit/`) followed by fixes, done test-first, then an independent review of the result and a second round of fixes. Tests went from 4 to 824 (75 files); TypeScript errors from 148 to 0; lint errors from 243 to 0. The production build now fails on type errors instead of hiding them, and builds without any environment variables. Production code shrank by about 24,000 lines.

## Security
- Removed `/api/generate-styleguide`, which gave anyone the full paid guide without signing in. Paid sections now come only from `/api/expand-style-guide`, which checks the plan on the server.
- Removed unauthenticated legacy routes: `ai-assist`, `rewrite-section`, `test-email`, the `/api` test page, the one-time checkout and the PDF fallback route.
- Website scraping blocks private and internal addresses (SSRF), re-checks redirects and caps response size.
- Login redirects (`redirectTo`, `next`) only allow same-site paths, which closes an open redirect and a `javascript:` URL injection.
- PDF export needs a login; server Chrome runs with JavaScript off and no outside network.
- Editor AI is paid-only, uses a server-chosen model and caps input size.
- Webflow publishing needs a shared secret.
- Rate limits on every route that calls OpenAI.
- Server-only modules can no longer be imported into client code; `OPENAI_API_KEY` is no longer inlined at build time.
- New migration with row-level security, protected billing columns and a database-side guide limit (to be applied by the owner).

## Billing
- One Stripe module. The webhook retries failed updates, ignores duplicate events and writes Stripe's current state.
- Unknown prices no longer downgrade paying customers; lapsed subscriptions (`past_due`, `unpaid`, ...) no longer keep paid features.
- Users who already subscribe are sent to the billing portal instead of a second checkout.
- `verify-subscription` checks the specific checkout session and never re-activates a cancelled plan.
- One set of guide limits everywhere (Starter 1, Pro 2, Agency 99). Saving at the limit returns an error instead of silently overwriting another guide.

## Generation quality
- Style rules keep times, URLs and punctuation intact; no stray headings.
- Expanded guides now use the full brand voice traits in their prompts.
- A failed section stays locked and can be retried, instead of saving "Could not generate".
- JSON mode, truncation checks and one validation retry for model output; one shared OpenAI client with timeouts.

## App
- `/guide` page rewritten from 1,795 to about 330 lines (hooks and components).
- Autosave no longer loses the last edits when leaving the page.
- Word and Markdown exports no longer drop lines or change heading levels; Word lists and tables are valid.
- Editing no longer moves locked sections to the end or shows "Questions?" twice.
- Paid users are no longer shown as Starter on a second visit to a guide.
- Drafts are cleared on sign-out and never claimed into another account after 24 hours.
- Session replay masks text and inputs.

## Cleanup
- About 160 dead files and 43 unused dependencies removed (old Plate playground, blog system, legacy pages).
- `middleware.ts` renamed to `proxy.ts` for Next 16; ESLint flat config; `.env.example`.

## Review round
- Webhook acknowledges events for subscriptions no profile owns (no endless retries).
- First-time checkouts share one Stripe customer, so parallel checkouts cannot double-bill.
- Expanding a guide keeps a "Questions?" section the user edited, and tolerates older saved brand details.
- The migration drops every old policy, so leftover public-read policies cannot undo RLS.
- Drafts stay claimable while the visitor is active; a guide blocked at the limit saves after an upgrade or delete.
- The guide is read-only while the full guide generates; sign-out saves pending edits first and resets analytics identity.

## Owner actions
See the end of `docs/audit/PLAN.md`.
