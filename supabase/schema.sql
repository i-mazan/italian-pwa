-- Parole: database schema for a fresh Supabase project.
-- Run once in the Supabase SQL Editor. Not safe to re-run on a project that already has these tables.
-- Also in the dashboard: Authentication -> turn off "Allow new users to sign up", and create users by hand.

-- ---------- words ----------
create table public.words (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  it text not null,
  ru text not null,
  pos text not null default 'other',
  def_article text not null default '',
  indef_article text not null default '',
  example text not null default '',
  conj jsonb,
  srs jsonb not null default '{}',
  created_at bigint,                     -- when the word was added (ms); used for "sort by date added"
  updated_at bigint not null,            -- the app's updatedAt (ms); the newer one wins when merging
  deleted boolean not null default false, -- tombstone, so a synced device doesn't bring deleted words back
  synced_at timestamptz not null default now() -- set by the server on every write; devices pull by this
);

alter table public.words enable row level security;

create policy "own rows" on public.words for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.touch_synced_at() returns trigger
language plpgsql as $$
begin
  new.synced_at = now();
  return new;
end $$;

create trigger words_touch_synced_at before insert or update on public.words
  for each row execute function public.touch_synced_at();

create index on public.words (user_id, synced_at);

-- ---------- daily_log ----------
-- One row per user, device and day. The app sums the other devices' rows for the streak and today's count.
create table public.daily_log (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id text not null,
  day text not null,                      -- YYYY-MM-DD
  n integer not null default 0,           -- answers
  ok integer not null default 0,          -- correct answers
  primary key (user_id, device_id, day)
);

alter table public.daily_log enable row level security;

create policy "own rows" on public.daily_log for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
