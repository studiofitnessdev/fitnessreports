-- Lets Anderson change the Professor login's password from the Configurações screen.
-- Run once in Supabase → SQL Editor (only needed if schema.sql was run before this change).
--
-- Changing another user's password normally needs the secret admin key, which can't live in a public site.
-- This function does it inside the database instead, with strict limits:
--   * only the owner can call it;
--   * it takes no user id or email: it can only ever change the login(s) with role 'teacher';
--   * it signs those logins out everywhere (open phones must log in again with the new password;
--     an already-open screen keeps working for up to ~1 hour, until its access token expires).
-- Anderson's own password is changed through Supabase Auth directly (no SQL needed).

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
