-- HCunion Voicechat password-free guest room presence
-- Enable Anonymous Sign-Ins in Supabase Authentication settings before using the site.
-- Run this entire file in the Supabase SQL Editor.

create table if not exists public.room_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  room_key text not null,
  room_name text not null,
  room_code text not null,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  force_closed boolean not null default false
);

alter table public.room_sessions
  add column if not exists force_closed boolean not null default false;

alter table public.room_sessions enable row level security;

revoke all on public.room_sessions from anon, authenticated;
grant select, insert, update, delete on public.room_sessions to authenticated;

drop policy if exists "Users manage their own room presence" on public.room_sessions;
drop policy if exists "Platform admins read all room presence" on public.room_sessions;
drop policy if exists "Platform admins close rooms" on public.room_sessions;
drop policy if exists "Guests manage their own room presence" on public.room_sessions;

-- Supabase anonymous users receive the authenticated database role.
-- Each guest can only create, update, and remove their own room-presence row.
create policy "Guests manage their own room presence"
  on public.room_sessions
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
