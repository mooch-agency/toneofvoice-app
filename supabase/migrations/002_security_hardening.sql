-- =============================================================================
-- 002_security_hardening.sql
--
-- REVIEW BEFORE APPLYING. The live schema for `profiles` and `style_guides` is
-- not in this repo, so this migration was written from how the app uses them.
-- Check it against the live database first (for example `supabase db pull`
-- into a scratch branch), and apply it to a staging project before production.
--
-- What it does (all statements are idempotent):
--   1. profiles: RLS on; every existing policy on profiles and style_guides is
--      dropped first; users can read only their own row; anon cannot read;
--      users (anon and authenticated) lose INSERT/UPDATE/DELETE. Billing columns are written
--      only by the service role (Stripe webhook, verify-subscription).
--      Rows are created by the existing new-user trigger (runs as its owner),
--      which this does not affect.
--   2. style_guides: RLS on with owner-only select/insert/update/delete.
--   3. style_guides: BEFORE INSERT trigger enforcing the per-tier guide limit
--      (same numbers as lib/tiers.ts), serialised per user so parallel inserts
--      cannot exceed it. The app maps the error "guide_limit_reached" to 403.
--   4. stripe_events: webhook idempotency table, service role only.
--   5. blog_posts (from 001, if present): RLS on, public read of published
--      posts only, no writes for anon/authenticated.
--
-- Rollback notes: `alter table ... disable row level security`,
-- `drop trigger style_guides_enforce_limit on public.style_guides`,
-- `grant insert, update, delete on public.profiles to authenticated`.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. profiles
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.style_guides enable row level security;

-- Policies are permissive (OR-ed together), so one leftover policy such as the
-- Supabase template's "Public profiles are viewable by everyone." would undo
-- everything below. Drop every existing policy on both tables, then recreate
-- only the owner-only ones.
do $$
declare
  p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('profiles', 'style_guides')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end
$$;

create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (id = auth.uid());

-- Anonymous visitors never read profiles.
revoke select on public.profiles from anon;

-- A column-level REVOKE does not override a table-level grant, so revoke the
-- table-level write privileges. Nothing in the app writes profiles with a user
-- session; all writes use the service role.
revoke insert, update, delete on public.profiles from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. style_guides: owner-only access
-- -----------------------------------------------------------------------------
create policy "style_guides_select_own" on public.style_guides
  for select to authenticated
  using (user_id = auth.uid());

create policy "style_guides_insert_own" on public.style_guides
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "style_guides_update_own" on public.style_guides
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "style_guides_delete_own" on public.style_guides
  for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.style_guides from anon;

-- -----------------------------------------------------------------------------
-- 3. Guide limit (keep in sync with TIER_LIMITS / effectiveTier in lib/tiers.ts)
--    starter = 1, pro = 2, agency = 99; a lapsed status counts as starter.
-- -----------------------------------------------------------------------------
create or replace function public.guide_limit_for(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
      when lower(coalesce(p.subscription_status, '')) in (
        'inactive', 'cancelled', 'canceled', 'past_due', 'unpaid',
        'incomplete', 'incomplete_expired', 'paused'
      ) then 1
      when lower(coalesce(p.subscription_tier, '')) = 'pro' then 2
      when lower(coalesce(p.subscription_tier, '')) in ('agency', 'team') then 99
      else 1
    end
    from public.profiles p
    where p.id = p_user
  ), 1)
$$;

create or replace function public.enforce_style_guide_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
begin
  -- Serialise inserts per user so two parallel requests cannot both pass the count.
  perform pg_advisory_xact_lock(hashtextextended('style_guides:' || new.user_id::text, 0));

  v_limit := public.guide_limit_for(new.user_id);
  select count(*) into v_count from public.style_guides where user_id = new.user_id;

  if v_count >= v_limit then
    raise exception 'guide_limit_reached'
      using errcode = 'P0001', detail = format('limit=%s used=%s', v_limit, v_count);
  end if;
  return new;
end;
$$;

-- Not callable through the API (PostgREST exposes public functions as RPC).
revoke all on function public.guide_limit_for(uuid) from public, anon, authenticated;
revoke all on function public.enforce_style_guide_limit() from public, anon, authenticated;

drop trigger if exists style_guides_enforce_limit on public.style_guides;
create trigger style_guides_enforce_limit
  before insert on public.style_guides
  for each row execute function public.enforce_style_guide_limit();

-- -----------------------------------------------------------------------------
-- 4. stripe_events: webhook idempotency (service role only; RLS with no policies)
-- -----------------------------------------------------------------------------
create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. blog_posts (created by 001 without RLS; no longer used by the app)
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.blog_posts') is not null then
    execute 'alter table public.blog_posts enable row level security';
    execute 'drop policy if exists "blog_posts_public_read" on public.blog_posts';
    execute 'create policy "blog_posts_public_read" on public.blog_posts
               for select to anon, authenticated using (is_published = true)';
    execute 'revoke insert, update, delete on public.blog_posts from anon, authenticated';
  end if;
end
$$;

commit;
