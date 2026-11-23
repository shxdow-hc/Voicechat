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
