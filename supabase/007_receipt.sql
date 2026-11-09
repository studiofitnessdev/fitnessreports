-- Receipt number for both logins (Imprimir recibo after "Fechar venda").
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
-- The teacher can't read sales, so a plain insert can't give back the new receipt number.
-- add_sale() inserts the sale and returns only that sale's number and time, never any other sale.
-- id, created_at and created_by are always set by the database, whatever the app sends.
create or replace function public.add_sale(sale jsonb)
returns json
language plpgsql security definer set search_path = public as $$
declare
  new_id bigint;
  new_at timestamptz;
begin
  if not public.is_staff() then
    raise exception 'only staff can add sales' using errcode = '42501';
  end if;
  insert into public.sales as s (client_id, client_name, amount, payment_method, class_time, plan,
                                 days_per_week, plan_start, plan_end, notes, signature, created_by)
  select r.client_id, r.client_name, r.amount, r.payment_method, r.class_time, r.plan,
         r.days_per_week, r.plan_start, r.plan_end, r.notes, r.signature, auth.uid()
  from jsonb_populate_record(null::public.sales, sale) r
  returning s.id, s.created_at into new_id, new_at;
  return json_build_object('id', new_id, 'created_at', new_at);
end;
$$;

revoke execute on function public.add_sale(jsonb) from public, anon;
grant execute on function public.add_sale(jsonb) to authenticated;
