-- Studio Fitness — database schema
-- Run this whole file once in Supabase: SQL Editor → New query → paste → Run.

-- ─────────────────────────────────────────────
-- Roles: one row per login (owner / teacher)
-- ─────────────────────────────────────────────
create table public.profiles (
  id   uuid primary key references auth.users on delete cascade,
  role text not null check (role in ('owner', 'teacher'))
);

alter table public.profiles enable row level security;

create policy "users read their own profile"
  on public.profiles for select to authenticated
  using (id = auth.uid());

-- Helper functions used by the policies below.
-- security definer so they can read profiles regardless of RLS.
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid());
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'owner');
$$;

-- ─────────────────────────────────────────────
-- Clients
-- ─────────────────────────────────────────────
create table public.clients (
  id         bigint generated always as identity primary key,
  name       text not null,
  cpf        text,
  created_at timestamptz not null default now()
);

alter table public.clients enable row level security;

create policy "staff read clients"   on public.clients for select to authenticated using (public.is_staff());
create policy "staff add clients"    on public.clients for insert to authenticated with check (public.is_staff());
create policy "staff edit clients"   on public.clients for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "owner delete clients" on public.clients for delete to authenticated using (public.is_owner());

-- ─────────────────────────────────────────────
-- Sales (receipts)
-- Numbering continues from the old app (last receipt was #6517).
-- ─────────────────────────────────────────────
create table public.sales (
  id             bigint generated always as identity (start with 6518) primary key,
  created_at     timestamptz not null default now(),
  client_id      bigint references public.clients on delete set null,
  client_name    text not null,
  amount         numeric(10, 2) not null check (amount >= 0),
  payment_method text not null check (payment_method in ('pix', 'credito', 'debito', 'dinheiro')),
  class_time     text not null check (class_time ~ '^\d{2}:\d{2}$'),
  plan           text not null check (plan in ('mensal', 'semestral', 'anual')),
  days_per_week  text not null check (days_per_week in ('1', '2', '3', '4+')),
  plan_start     date not null,
  plan_end       date not null,
  notes          text,
  signature      text,
  created_by     uuid not null default auth.uid() references auth.users
);

create index sales_created_at_idx on public.sales (created_at desc);

alter table public.sales enable row level security;

-- Teacher and owner can register sales…
create policy "staff add sales" on public.sales for insert to authenticated
  with check (public.is_staff() and created_by = auth.uid());

-- …but only the owner can see, change or delete them (values and totals).
create policy "owner read sales"   on public.sales for select to authenticated using (public.is_owner());
create policy "owner edit sales"   on public.sales for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "owner delete sales" on public.sales for delete to authenticated using (public.is_owner());

-- ─────────────────────────────────────────────
-- Subscription status per client (Clientes tab), for both logins.
-- Returns only the plan dates of each client's sale that reaches furthest: no amounts.
-- ─────────────────────────────────────────────
create index sales_client_end_idx on public.sales (client_id, plan_end desc);

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

-- ─────────────────────────────────────────────
-- Database usage for the "Config" screen (owner only).
-- ─────────────────────────────────────────────
create or replace function public.db_usage()
returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner() then
    raise exception 'only the owner can see usage' using errcode = '42501';
  end if;
  return json_build_object(
    'db_bytes',      pg_database_size(current_database()),
    'sales_bytes',   pg_total_relation_size('public.sales'),
    'clients_bytes', pg_total_relation_size('public.clients'),
    'sales_rows',    (select count(*) from public.sales),
    'clients_rows',  (select count(*) from public.clients),
    'sales_90d',     (select count(*) from public.sales where created_at >= now() - interval '90 days'),
    'first_sale',    (select min(created_at) from public.sales),
    -- average size of a recent sale row, to project growth
    'row_bytes',     (select coalesce(avg(pg_column_size(r.*)), 0)::int
                        from (select * from public.sales order by id desc limit 500) r),
    'users',         (select count(*) from auth.users),
    'users_month',   (select count(*) from auth.users where last_sign_in_at >= date_trunc('month', now()))
  );
end;
$$;

revoke execute on function public.db_usage() from public, anon;
grant execute on function public.db_usage() to authenticated;

-- ─────────────────────────────────────────────
-- Anderson changes the Professor password (Configurações). Owner only; can only touch the teacher login(s).
-- ─────────────────────────────────────────────
create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_teacher_password(new_password text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  changed int;
begin
  if not public.is_owner() then
    raise exception 'only the owner can change passwords' using errcode = '42501';
  end if;
  if new_password is null or length(new_password) < 6 then
    raise exception 'password must have at least 6 characters' using errcode = '22023';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id in (select id from public.profiles where role = 'teacher');
  get diagnostics changed = row_count;
  if changed = 0 then
    raise exception 'teacher login not found' using errcode = 'P0002';
  end if;

  delete from auth.sessions where user_id in (select id from public.profiles where role = 'teacher');
end;
$$;

revoke execute on function public.set_teacher_password(text) from public, anon;
grant execute on function public.set_teacher_password(text) to authenticated;

-- ─────────────────────────────────────────────
-- "Apagar todos os dados" (Configurações). Owner only; deletes only rows covered by the backup just taken.
-- ─────────────────────────────────────────────
create or replace function public.wipe_data(max_sale_id bigint, max_client_id bigint)
returns json
language plpgsql security definer set search_path = public as $$
declare
  sales_deleted int;
  clients_deleted int;
begin
  if not public.is_owner() then
    raise exception 'only the owner can wipe data' using errcode = '42501';
  end if;
  delete from public.sales where id <= coalesce(max_sale_id, 0);
  get diagnostics sales_deleted = row_count;
  delete from public.clients where id <= coalesce(max_client_id, 0);
  get diagnostics clients_deleted = row_count;
  return json_build_object('sales', sales_deleted, 'clients', clients_deleted);
end;
$$;

revoke execute on function public.wipe_data(bigint, bigint) from public, anon;
grant execute on function public.wipe_data(bigint, bigint) to authenticated;
