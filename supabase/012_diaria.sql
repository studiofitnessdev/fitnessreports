-- Adds the Diária plan (day pass: starts and ends on the day of the sale).
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).

alter table public.sales drop constraint sales_plan_check;
alter table public.sales add constraint sales_plan_check
  check (plan in ('diaria', 'mensal', 'trimestral', 'semestral', 'anual'));
