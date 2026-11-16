-- Adds the Trimestral plan (3 months) and changes Dias por semana to 2, 3, 4 or 5.
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
-- '1' and '4+' stay allowed so older sales remain valid; the app no longer offers them.

alter table public.sales drop constraint sales_plan_check;
alter table public.sales add constraint sales_plan_check
  check (plan in ('mensal', 'trimestral', 'semestral', 'anual'));

alter table public.sales drop constraint sales_days_per_week_check;
alter table public.sales add constraint sales_days_per_week_check
  check (days_per_week in ('2', '3', '4', '5', '1', '4+'));
