-- Removes the TEST DATA created by supabase/demo_seed.sql, and nothing else.
-- Run in Supabase → SQL Editor after the demo.
-- - Deletes only the sales (and test clients) listed in the "demo" schema. Real sales made in the
--   meantime stay. A test client that got a real sale meanwhile is kept.
-- - Puts the receipt numbering back: the next real receipt continues from where it was before the
--   test data (or right after the last real sale, if real sales were made meanwhile).

do $$
declare
  seq text := pg_get_serial_sequence('public.sales', 'id');
  next_before bigint;
  n_sales int := 0;
  n_clients int := 0;
begin
  if to_regclass('demo.sales') is null then
    raise notice 'Não há dados de teste para apagar.';
    return;
  end if;

  delete from public.sales where id in (select id from demo.sales);
  get diagnostics n_sales = row_count;
  delete from public.clients c
  where c.id in (select id from demo.clients)
    and not exists (select 1 from public.sales s where s.client_id = c.id);
  get diagnostics n_clients = row_count;

  select value into next_before from demo.info where key = 'next_sale_id';
  perform setval(seq, greatest(coalesce(next_before, 1), coalesce((select max(id) + 1 from public.sales), 1)), false);

  drop schema demo cascade;
  raise notice 'Apagadas % vendas de teste e % clientes de teste.', n_sales, n_clients;
end $$;

select (select count(*) from public.sales) as vendas_restantes, (select count(*) from public.clients) as clientes;
