-- Database usage numbers for the "Config" screen (Anderson only).
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
--
-- security definer so it can read sizes and the login count; refuses anyone who isn't the owner.

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
