-- =============================================================================
-- 004_revoke_table_privileges.sql
--
-- Supabase's default grants give anon and authenticated TRUNCATE, REFERENCES
-- and TRIGGER on every public table. TRUNCATE ignores RLS. PostgREST cannot
-- issue it, but a leaked direct connection as those roles could, so remove
-- privileges the app never needs. Idempotent; tables that don't exist are skipped.
-- Rollback: `grant truncate, references, trigger on public.<table> to anon, authenticated`.
-- =============================================================================

begin;

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'style_guides', 'style_guide_versions', 'stripe_events', 'rate_limits', 'blog_posts']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', t);
    end if;
  end loop;
end
$$;

commit;
