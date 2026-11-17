-- Unique CPF, client phone (renewal list / WhatsApp) and "Editar venda".
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
-- If it stops with "CPFs repetidos", fix those clients in the app (Clientes) and run it again;
-- nothing is changed until it runs through.

-- 1. Every real CPF only once. 00000000000 means "no CPF" and can repeat.
do $$
declare dups text;
begin
  select string_agg(format('%s: %s', d.cpf, d.names), ' | ') into dups
  from (select cpf, string_agg(name, ' / ' order by id) as names
        from public.clients
        where cpf is not null and cpf <> '00000000000'
        group by cpf having count(*) > 1) d;
  if dups is not null then
    raise exception 'CPFs repetidos (corrija no app e rode de novo): %', dups;
  end if;
end $$;

create unique index if not exists clients_cpf_unique on public.clients (cpf)
  where cpf is not null and cpf <> '00000000000';

-- 2. Clients without CPF all use the same value (the app shows it as "Sem CPF").
update public.clients set cpf = '00000000000' where cpf is null or cpf = '';

-- 3. Phone (digits only: DDD + number), optional.
alter table public.clients add column if not exists phone text
  check (phone is null or phone ~ '^\d{10,11}$');

-- 4. edit_sale(): fixes a sale instead of deleting it (both logins). Same receipt number.
-- The teacher can change client, plan, days, time and dates; amount, payment method and observação
-- only change for the owner (ignored for the teacher). Returns only plan details, never the amount.
create or replace function public.edit_sale(sale_id bigint, changes jsonb)
returns json
language plpgsql security definer set search_path = public as $$
declare
  owner boolean := public.is_owner();
  new_client_id bigint := (changes->>'client_id')::bigint;
  new_client_name text;
  r public.sales;
begin
  if not public.is_staff() then
    raise exception 'only staff can edit sales' using errcode = '42501';
  end if;
  if new_client_id is not null then
    select name into new_client_name from public.clients where id = new_client_id;
    if new_client_name is null then
      raise exception 'client not found' using errcode = 'P0002';
    end if;
  end if;
  update public.sales s set
    client_id      = coalesce(new_client_id, s.client_id),
    client_name    = coalesce(new_client_name, s.client_name),
    plan           = coalesce(changes->>'plan', s.plan),
    days_per_week  = coalesce(changes->>'days_per_week', s.days_per_week),
    class_time     = coalesce(changes->>'class_time', s.class_time),
    plan_start     = coalesce((changes->>'plan_start')::date, s.plan_start),
    plan_end       = coalesce((changes->>'plan_end')::date, s.plan_end),
    amount         = case when owner and changes ? 'amount' then (changes->>'amount')::numeric else s.amount end,
    payment_method = case when owner and changes ? 'payment_method' then changes->>'payment_method' else s.payment_method end,
    notes          = case when owner and changes ? 'notes' then nullif(changes->>'notes', '') else s.notes end
  where s.id = sale_id
  returning s.* into r;
  if not found then
    raise exception 'sale not found' using errcode = 'P0002';
  end if;
  if r.plan_end < r.plan_start then
    raise exception 'plan_end before plan_start' using errcode = '22023';
  end if;
  return json_build_object('id', r.id, 'client_id', r.client_id, 'client_name', r.client_name, 'plan', r.plan,
    'days_per_week', r.days_per_week, 'class_time', r.class_time, 'plan_start', r.plan_start, 'plan_end', r.plan_end);
end;
$$;

revoke execute on function public.edit_sale(bigint, jsonb) from public, anon;
grant execute on function public.edit_sale(bigint, jsonb) to authenticated;

-- Make the new column visible to the app right away.
notify pgrst, 'reload schema';
