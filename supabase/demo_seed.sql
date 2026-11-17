-- TEST DATA for a demo: about 12 months of realistic sales (with renewals, late renewals and clients who
-- stopped), so Histórico, Clientes (Vencendo / Vencidos) and Insights have something to show.
-- Run in Supabase → SQL Editor. Remove everything afterwards with supabase/demo_cleanup.sql.
--
-- - Uses the clients already registered. If there are fewer than 50, it first creates 350 test clients
--   (fake names, "Sem CPF", no phone; so no WhatsApp message can reach a real person).
-- - Every test row is listed in the "demo" schema (not visible to the app), so the cleanup deletes
--   exactly these and nothing else. It also puts the receipt numbering back where it was.
-- - Needs supabase/009_plans.sql (Trimestral, 2–5 dias).

create schema if not exists demo;
revoke all on schema demo from public, anon, authenticated;
create table if not exists demo.sales   (id bigint primary key);
create table if not exists demo.clients (id bigint primary key);
create table if not exists demo.info    (key text primary key, value bigint);

do $$
declare
  owner_id uuid;
  next_id bigint;
  first_names text[] := array['ANA','BRUNO','CARLA','DIEGO','EDUARDA','FELIPE','GABRIELA','HENRIQUE','ISABELA','JOÃO',
    'JULIANA','LUCAS','MARIANA','MATEUS','NATÁLIA','OTÁVIO','PATRÍCIA','RAFAEL','RENATA','RODRIGO','SABRINA','THIAGO',
    'VANESSA','VINÍCIUS','ALINE','CAIO','DÉBORA','FERNANDA','GUSTAVO','LARISSA','LEONARDO','MARCOS','PAULA','PEDRO',
    'PRISCILA','RICARDO','TATIANE','VITOR','BEATRIZ','DANIEL'];
  last_names text[] := array['SILVA','SOUZA','OLIVEIRA','SANTOS','PEREIRA','LIMA','COSTA','RIBEIRO','ALVES','GOMES',
    'MARTINS','ROCHA','CARVALHO','ARAÚJO','MELO','BARBOSA','CARDOSO','TEIXEIRA','MOREIRA','FERREIRA','MENDES','NUNES',
    'BORGES','REIS','FARIA','MIRANDA','PIRES','CASTRO','RAMOS','LOPES'];
  times text[] := array['06:00','06:00','06:30','07:00','07:00','07:00','08:00','09:00','12:00','12:00','17:00','17:30',
    '18:00','18:00','18:00','18:30','19:00','19:00','19:00','20:00','20:00','21:00'];
  base_price numeric[] := array[110, 140, 160, 180]; -- Mensal for 2, 3, 4, 5 days per week
  cli record;
  i int;
  v_day date;
  v_plan text;
  v_months int;
  v_days text;
  v_time text;
  v_pay text;
  v_price numeric;
  v_at timestamptz;
  v_end date;
  new_id bigint;
  r double precision;
  n_sales int := 0;
  n_clients int;
begin
  select id into owner_id from public.profiles where role = 'owner' limit 1;
  if owner_id is null then
    raise exception 'Falta o login do Anderson: rode supabase/users.sql antes.';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_plan_check'
                 and pg_get_constraintdef(oid) like '%trimestral%') then
    raise exception 'Rode supabase/009_plans.sql antes (plano Trimestral).';
  end if;
  if exists (select 1 from demo.sales) then
    raise exception 'Já existem vendas de teste. Rode supabase/demo_cleanup.sql antes de gerar de novo.';
  end if;

  -- Where receipt numbering is now, so the cleanup can put it back
  execute format('select case when is_called then last_value + 1 else last_value end from %s',
                 pg_get_serial_sequence('public.sales', 'id')) into next_id;
  insert into demo.info values ('next_sale_id', next_id)
    on conflict (key) do update set value = excluded.value;

  -- Test clients only when the app has (almost) none
  if (select count(*) from public.clients) < 50 then
    for i in 1..350 loop
      insert into public.clients (name, cpf)
      values (first_names[1 + floor(random() * array_length(first_names, 1))::int] || ' ' ||
              last_names[1 + floor(random() * array_length(last_names, 1))::int] || ' ' ||
              last_names[1 + floor(random() * array_length(last_names, 1))::int],
              '00000000000')
      returning id into new_id;
      insert into demo.clients values (new_id);
    end loop;
  end if;

  -- One "journey" per client: first sale somewhere in the last 12 months (more recent ones more likely,
  -- so the business grows), then renewals around the end of each plan until the client stops.
  for cli in select id, name from public.clients order by random() limit 650 loop
    v_day := current_date - floor(365 * power(random(), 1.3))::int;
    r := random();
    v_plan := case when r < .62 then 'mensal' when r < .82 then 'trimestral' when r < .93 then 'semestral' else 'anual' end;
    r := random();
    v_days := case when r < .18 then '2' when r < .60 then '3' when r < .85 then '4' else '5' end;
    v_time := times[1 + floor(random() * array_length(times, 1))::int];

    loop
      if extract(dow from v_day) = 0 then v_day := v_day + 1; end if; -- closed on Sundays
      -- Sold at the front desk around the class time, Brazil time
      v_at := (v_day + (v_time::time - interval '25 minutes' + random() * interval '50 minutes'))
                 at time zone 'America/Sao_Paulo';
      exit when v_at > now();

      v_months := case v_plan when 'mensal' then 1 when 'trimestral' then 3 when 'semestral' then 6 else 12 end;
      v_end := (v_day + make_interval(months => v_months))::date;
      v_price := base_price[v_days::int - 1] * v_months
               * case v_plan when 'mensal' then 1 when 'trimestral' then .93 when 'semestral' then .87 else .80 end;
      v_price := round(v_price / 5) * 5;
      if random() < .08 then v_price := round(v_price * .9 / 5) * 5; end if; -- occasional discount
      r := random();
      v_pay := case when r < .46 then 'pix' when r < .71 then 'credito' when r < .90 then 'debito' else 'dinheiro' end;

      insert into public.sales (client_id, client_name, amount, payment_method, class_time, plan, days_per_week,
                                plan_start, plan_end, notes, signature, created_at, created_by)
      values (cli.id, cli.name, v_price, v_pay, v_time, v_plan, v_days, v_day, v_end,
              format('Plano %s: %s a %s', initcap(v_plan), to_char(v_day, 'DD/MM/YYYY'), to_char(v_end, 'DD/MM/YYYY')),
              case when random() < .6 then 'Anderson' else 'Professor' end, v_at, owner_id)
      returning id into new_id;
      insert into demo.sales values (new_id);
      n_sales := n_sales + 1;

      exit when random() < .28; -- stopped training (shows up as Vencido)
      v_day := v_end + floor(random() * 12 - 4)::int; -- renews a few days early or late
      if random() < .2 then -- sometimes switches plan
        r := random();
        v_plan := case when r < .55 then 'mensal' when r < .80 then 'trimestral' when r < .93 then 'semestral' else 'anual' end;
      end if;
    end loop;
  end loop;

  select count(*) into n_clients from demo.clients;
  raise notice 'Criadas % vendas de teste (e % clientes de teste).', n_sales, n_clients;
end $$;

select (select count(*) from demo.sales) as vendas_de_teste,
       (select count(*) from demo.clients) as clientes_de_teste,
       (select min(created_at)::date from public.sales where id in (select id from demo.sales)) as primeira,
       (select max(created_at)::date from public.sales where id in (select id from demo.sales)) as ultima;
