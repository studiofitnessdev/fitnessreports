-- Observação follows an edited sale, and a Diária is not a plan to renew.
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
-- The app works without it (the Observação of a sale the Professor edits just keeps the old dates, and the
-- app hides Diárias from Clientes on its own).

-- 1. The Observação text the app fills in for a sale (same as autoNote() in js/app.js).
create or replace function public.sale_auto_note(p_plan text, p_start date, p_end date)
returns text
language sql stable set search_path = public as $$
  select case when p_plan = 'diaria' then 'Diária: ' || to_char(p_start, 'DD/MM/YYYY')
              else 'Plano ' || initcap(p_plan) || ': ' || to_char(p_start, 'DD/MM/YYYY') || ' a ' || to_char(p_end, 'DD/MM/YYYY')
         end;
$$;

revoke execute on function public.sale_auto_note(text, date, date) from public, anon;

-- 2. edit_sale(): as in 011, plus: when plan or dates change, the automatic "Plano Mensal: … a …" part of the
-- Observação is swapped for the new one (anything else written there is kept). Anderson's app already sends
-- the updated text; this covers the Professor, who can't see or send the Observação.
create or replace function public.edit_sale(sale_id bigint, changes jsonb)
returns json
language plpgsql security definer set search_path = public as $$
declare
  owner boolean := public.is_owner();
  new_client_id bigint := (changes->>'client_id')::bigint;
  new_client_name text;
  v_old public.sales;
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
  select * into v_old from public.sales s where s.id = sale_id for update;
  if not found then
    raise exception 'sale not found' using errcode = 'P0002';
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
  if r.plan_end < r.plan_start then
    raise exception 'plan_end before plan_start' using errcode = '22023';
  end if;
  if not (owner and changes ? 'notes') and r.notes is not null
     and (r.plan, r.plan_start, r.plan_end) is distinct from (v_old.plan, v_old.plan_start, v_old.plan_end) then
    update public.sales s
       set notes = replace(s.notes, public.sale_auto_note(v_old.plan, v_old.plan_start, v_old.plan_end),
                                    public.sale_auto_note(r.plan, r.plan_start, r.plan_end))
     where s.id = sale_id;
  end if;
  return json_build_object('id', r.id, 'client_id', r.client_id, 'client_name', r.client_name, 'plan', r.plan,
    'days_per_week', r.days_per_week, 'class_time', r.class_time, 'plan_start', r.plan_start, 'plan_end', r.plan_end);
end;
$$;

revoke execute on function public.edit_sale(bigint, jsonb) from public, anon;
grant execute on function public.edit_sale(bigint, jsonb) to authenticated;

-- 3. Clientes (Vencendo / Vencidos / Ativos): a Diária is a one-off visit, not a plan. The client's status
-- comes from their real plans only (a client who only did Diárias shows as Sem plano).
create or replace function public.client_subscriptions()
returns table (client_id bigint, plan text, plan_start date, plan_end date)
language sql stable security definer set search_path = public as $$
  select distinct on (s.client_id) s.client_id, s.plan, s.plan_start, s.plan_end
  from public.sales s
  where public.is_staff() and s.client_id is not null and s.plan <> 'diaria'
  order by s.client_id, s.plan_end desc, s.id desc;
$$;

revoke execute on function public.client_subscriptions() from public, anon;
grant execute on function public.client_subscriptions() to authenticated;
