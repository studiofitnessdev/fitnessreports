-- "Apagar todas as vendas" in Configurações: deletes only sales, never clients.
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
--
-- Same name and parameters as before (006_wipe.sql), so any open app keeps working; max_client_id is
-- now ignored. Only sales up to the id in the backup just taken are deleted, so sales made after the
-- backup stay. Clients, logins and passwords are not touched. Receipt numbers keep counting.

create or replace function public.wipe_data(max_sale_id bigint, max_client_id bigint)
returns json
language plpgsql security definer set search_path = public as $$
declare
  sales_deleted int;
begin
  if not public.is_owner() then
    raise exception 'only the owner can wipe data' using errcode = '42501';
  end if;
  delete from public.sales where id <= coalesce(max_sale_id, 0);
  get diagnostics sales_deleted = row_count;
  return json_build_object('sales', sales_deleted, 'clients', 0);
end;
$$;

revoke execute on function public.wipe_data(bigint, bigint) from public, anon;
grant execute on function public.wipe_data(bigint, bigint) to authenticated;
