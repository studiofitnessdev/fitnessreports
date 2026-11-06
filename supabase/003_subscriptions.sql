-- Subscription status per client (Clientes tab), for both logins.
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
--
-- The teacher can't read the sales table (values are owner-only), so this function returns
-- just the plan dates of each client's sale that covers the furthest date: no amounts, no payment info.

create index if not exists sales_client_end_idx on public.sales (client_id, plan_end desc);

create or replace function public.client_subscriptions()
returns table (client_id bigint, plan text, plan_start date, plan_end date)
language sql stable security definer set search_path = public as $$
  select distinct on (s.client_id) s.client_id, s.plan, s.plan_start, s.plan_end
  from public.sales s
  where public.is_staff() and s.client_id is not null
  order by s.client_id, s.plan_end desc, s.id desc;
$$;

revoke execute on function public.client_subscriptions() from public, anon;
grant execute on function public.client_subscriptions() to authenticated;
