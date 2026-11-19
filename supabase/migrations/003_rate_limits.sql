-- =============================================================================
-- 003_rate_limits.sql
--
-- Shared rate-limit counters for the API (lib/rate-limit-durable.ts). Without
-- this migration the app falls back to per-instance in-memory limits.
--
-- Fixed window per key: the first hit starts a window of p_window_ms; hits
-- inside the window count up; the window resets after it ends. The update is
-- a single atomic upsert, so parallel requests cannot slip past the limit.
-- Only the service role may call it. Idempotent.
-- =============================================================================

begin;

create table if not exists public.rate_limits (
  key text primary key,
  count integer not null,
  reset_at timestamptz not null
);

alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_ms integer)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_reset timestamptz;
  v_window interval := make_interval(secs => p_window_ms / 1000.0);
begin
  insert into public.rate_limits as r (key, count, reset_at)
  values (p_key, 1, now() + v_window)
  on conflict (key) do update
    set count = case when r.reset_at <= now() then 1 else r.count + 1 end,
        reset_at = case when r.reset_at <= now() then now() + v_window else r.reset_at end
  returning r.count, r.reset_at into v_count, v_reset;

  allowed := v_count <= p_limit;
  retry_after_seconds := case
    when allowed then 0
    else greatest(1, ceil(extract(epoch from (v_reset - now())))::integer)
  end;
  return next;
end;
$$;

revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- Old windows are useless; keep the table small. Safe to run any time.
create or replace function public.rate_limits_prune()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limits where reset_at < now() - interval '1 day';
$$;

revoke execute on function public.rate_limits_prune() from public, anon, authenticated;
grant execute on function public.rate_limits_prune() to service_role;

commit;
