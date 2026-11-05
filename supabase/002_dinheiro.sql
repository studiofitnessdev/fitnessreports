-- Adds "dinheiro" (cash) as a payment method.
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).

alter table public.sales drop constraint sales_payment_method_check;
alter table public.sales add constraint sales_payment_method_check
  check (payment_method in ('pix', 'credito', 'debito', 'dinheiro'));
