-- Run AFTER creating the two users in Authentication → Users → Add user
-- (check "Auto Confirm User"). The emails must match js/config.js.

insert into public.profiles (id, role)
select id, 'owner' from auth.users where email = 'anderson@studiofitness.app';

insert into public.profiles (id, role)
select id, 'teacher' from auth.users where email = 'professores@studiofitness.app';

-- Check: should list both emails with their roles.
select u.email, p.role from public.profiles p join auth.users u on u.id = p.id;
