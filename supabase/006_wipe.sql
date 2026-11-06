-- "Apagar todos os dados" in Configurações (Anderson only).
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
--
-- Deletes sales and clients in one transaction (all or nothing). It only deletes rows up to the ids
-- the app just exported in the backup, so anything created after the backup (e.g. a sale made by
-- the teacher in the meantime) is kept. Logins and passwords are not touched. Receipt numbers keep
-- counting from where they were (no repeated numbers).

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
