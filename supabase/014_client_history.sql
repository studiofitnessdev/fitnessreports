-- Ficha do cliente (Clientes → tap a client): every purchase of that client, for both logins.
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
-- Without it Anderson's app still shows the page (it reads the sales table); the Professor's says "Falta configurar".
-- Returns only plan details, never amounts or payment methods (the same columns as staff_history()).
create or replace function public.client_history(p_client_id bigint)
returns table (id bigint, created_at timestamptz, plan text, days_per_week text, class_time text,
               plan_start date, plan_end date)
language sql stable security definer set search_path = public as $$
  select s.id, s.created_at, s.plan, s.days_per_week, s.class_time, s.plan_start, s.plan_end
  from public.sales s
  where public.is_staff() and s.client_id = p_client_id
  order by s.created_at desc, s.id desc;
$$;

revoke execute on function public.client_history(bigint) from public, anon;
grant execute on function public.client_history(bigint) to authenticated;

-- Make the new function visible to the app right away.
notify pgrst, 'reload schema';
