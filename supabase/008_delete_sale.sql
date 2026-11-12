-- Histórico for both logins + "Apagar venda".
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
--
-- staff_history(): the Professor's Histórico. Same idea as client_subscriptions(): the teacher still
-- can't read the sales table, so this returns only plan details of the sales in a date range — never
-- the amount, payment method, observação or who attended.
-- delete_sale(): deletes one sale (both logins, whoever registered it). The client's plan status is
-- recomputed from their remaining sales by client_subscriptions(). Receipt numbers are never reused.

create or replace function public.staff_history(from_ts timestamptz, to_ts timestamptz)
returns table (id bigint, created_at timestamptz, client_id bigint, client_name text, plan text,
               days_per_week text, class_time text, plan_start date, plan_end date)
language sql stable security definer set search_path = public as $$
  select s.id, s.created_at, s.client_id, s.client_name, s.plan, s.days_per_week, s.class_time, s.plan_start, s.plan_end
  from public.sales s
  where public.is_staff() and s.created_at >= from_ts and s.created_at < to_ts
  order by s.created_at desc, s.id desc;
$$;

revoke execute on function public.staff_history(timestamptz, timestamptz) from public, anon;
grant execute on function public.staff_history(timestamptz, timestamptz) to authenticated;

create or replace function public.delete_sale(sale_id bigint)
returns int
language plpgsql security definer set search_path = public as $$
declare
  deleted int;
begin
  if not public.is_staff() then
    raise exception 'only staff can delete sales' using errcode = '42501';
  end if;
  delete from public.sales where id = sale_id;
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke execute on function public.delete_sale(bigint) from public, anon;
grant execute on function public.delete_sale(bigint) to authenticated;
