-- HCunion Voicechat username/password accounts
-- Run this entire file in Supabase Dashboard -> SQL Editor.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$')
);

-- Usernames are unique regardless of capitalization.
create unique index if not exists profiles_username_case_insensitive
  on public.profiles (lower(username));

alter table public.profiles enable row level security;

drop policy if exists "Authenticated users can read profiles" on public.profiles;
create policy "Authenticated users can read profiles"
  on public.profiles for select
  to authenticated
  using (true);

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
exception
  when unique_violation then
    raise exception 'Username already taken';
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();

-- Repair accounts that were created before the profile trigger was installed
-- or while the profile table setup was incomplete.
insert into public.profiles (id, username)
select
  u.id,
  u.raw_user_meta_data ->> 'username'
from auth.users u
where nullif(trim(u.raw_user_meta_data ->> 'username'), '') is not null
  and not exists (
    select 1 from public.profiles p where p.id = u.id
  )
on conflict do nothing;


-- One active browser/device session per account.
create table if not exists public.account_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id text not null,
  last_seen timestamptz not null default now()
);
alter table public.account_sessions enable row level security;

create or replace function public.claim_account_session(p_session_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare claimed boolean := false;
begin
  if auth.uid() is null or p_session_id is null or length(p_session_id) < 10 then
    return false;
  end if;
  insert into public.account_sessions(user_id, session_id, last_seen)
  values (auth.uid(), p_session_id, now())
  on conflict (user_id) do update
    set session_id = excluded.session_id, last_seen = now()
    where public.account_sessions.session_id = excluded.session_id
       or public.account_sessions.last_seen < now() - interval '90 seconds';
  select exists(
    select 1 from public.account_sessions
    where user_id = auth.uid() and session_id = p_session_id
  ) into claimed;
  return claimed;
end;
$$;

create or replace function public.refresh_account_session(p_session_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.account_sessions set last_seen = now()
  where user_id = auth.uid() and session_id = p_session_id;
  return found;
end;
$$;

create or replace function public.release_account_session(p_session_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.account_sessions
  where user_id = auth.uid() and session_id = p_session_id;
  return found;
end;
$$;

revoke all on public.account_sessions from anon, authenticated;
grant execute on function public.claim_account_session(text) to authenticated;
grant execute on function public.refresh_account_session(text) to authenticated;
grant execute on function public.release_account_session(text) to authenticated;

-- Owner-only dashboard: no account is privileged until manually inserted here.
create table if not exists public.platform_admins (
 user_id uuid primary key references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;
grant select on public.platform_admins to authenticated;
drop policy if exists "Users can check their own admin flag" on public.platform_admins;
create policy "Users can check their own admin flag" on public.platform_admins
 for select to authenticated using (user_id=auth.uid());

create table if not exists public.room_sessions (
 user_id uuid primary key references auth.users(id) on delete cascade,
 username text not null, room_key text not null, room_name text not null,
 room_code text not null, joined_at timestamptz not null default now(),
 last_seen timestamptz not null default now()
);
alter table public.room_sessions enable row level security;
revoke all on public.room_sessions from anon, authenticated;
grant select,insert,update,delete on public.room_sessions to authenticated;
drop policy if exists "Users manage their own room presence" on public.room_sessions;
create policy "Users manage their own room presence" on public.room_sessions
 for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
drop policy if exists "Platform admins read all room presence" on public.room_sessions;
create policy "Platform admins read all room presence" on public.room_sessions
 for select to authenticated using(exists(select 1 from public.platform_admins a where a.user_id=auth.uid()));

drop policy if exists "Authenticated users can read profiles" on public.profiles;
drop policy if exists "Users and platform admins can read profiles" on public.profiles;
create policy "Users and platform admins can read profiles" on public.profiles
 for select to authenticated using(id=auth.uid() or exists(select 1 from public.platform_admins a where a.user_id=auth.uid()));

-- Run once after confirming the owner's registered username:
-- insert into public.platform_admins(user_id)
-- select id from auth.users
-- where lower(raw_user_meta_data ->> 'username')=lower('REPLACE_WITH_OWNER_USERNAME')
-- on conflict(user_id) do nothing;

-- Allow only verified platform admins to inspect account online heartbeats.
grant select on public.account_sessions to authenticated;
drop policy if exists "Platform admins read account sessions" on public.account_sessions;
create policy "Platform admins read account sessions"
 on public.account_sessions for select to authenticated
 using (exists(select 1 from public.platform_admins a where a.user_id=auth.uid()));

-- Owner moderation controls: suspend accounts, revoke sessions, and close rooms.
alter table public.profiles add column if not exists suspended boolean not null default false;
grant update on public.profiles to authenticated;
drop policy if exists "Platform admins update account status" on public.profiles;
create policy "Platform admins update account status" on public.profiles
 for update to authenticated using(exists(select 1 from public.platform_admins a where a.user_id=auth.uid()))
 with check(exists(select 1 from public.platform_admins a where a.user_id=auth.uid()));

alter table public.room_sessions add column if not exists force_closed boolean not null default false;
grant update on public.room_sessions to authenticated;
drop policy if exists "Platform admins close rooms" on public.room_sessions;
create policy "Platform admins close rooms" on public.room_sessions
 for update to authenticated using(exists(select 1 from public.platform_admins a where a.user_id=auth.uid()))
 with check(exists(select 1 from public.platform_admins a where a.user_id=auth.uid()));

grant delete on public.account_sessions to authenticated;
drop policy if exists "Platform admins revoke account sessions" on public.account_sessions;
create policy "Platform admins revoke account sessions" on public.account_sessions
 for delete to authenticated using(exists(select 1 from public.platform_admins a where a.user_id=auth.uid()));
