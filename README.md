# Tone of Voice App

Generate a brand's tone of voice guide from a website URL or a short description, in a few minutes.

- **Live:** https://toneofvoice.app
- **Product and architecture:** [`PROJECT.md`](PROJECT.md)
- **Latest audit and plan:** [`docs/audit/PLAN.md`](docs/audit/PLAN.md)

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS · Supabase (auth + Postgres) · Stripe · OpenAI · Plate.js editor · Vitest

## Getting started

Requirements: Node.js 22+, pnpm 10.

```bash
pnpm install
cp .env.example .env.local   # then fill in the values
pnpm dev
```

Open http://localhost:3000.

## Scripts

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Dev server |
| `pnpm build` | Production build (type errors fail the build) |
| `pnpm start` | Serve the production build |
| `pnpm test` | Run all tests once |
| `pnpm test:watch` | Tests in watch mode |
| `pnpm typecheck` | TypeScript check |
| `pnpm lint` | ESLint |

## Database

Migrations live in `supabase/migrations/`. `002_security_hardening.sql` adds row-level security, the guide-limit trigger and the Stripe event table; `003_rate_limits.sql` adds shared rate-limit counters. Review them, then apply to staging before production.

## License

MIT
