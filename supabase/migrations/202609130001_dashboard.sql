-- Secure dashboard, channel registry, and upload history.
create extension if not exists pgcrypto;

create table if not exists public.youtube_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  youtube_channel_id text not null,
  display_name text not null,
  thumbnail_url text,
  active boolean not null default false,
  connected_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (user_id, youtube_channel_id)
);

create unique index if not exists youtube_channels_one_active_per_user
  on public.youtube_channels (user_id) where active;

create table if not exists public.youtube_channel_tokens (
  channel_id uuid primary key references public.youtube_channels(id) on delete cascade,
  token_ciphertext text not null,
  token_iv text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);

alter table public.videos add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.videos add column if not exists channel_id uuid references public.youtube_channels(id) on delete set null;

create table if not exists public.upload_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  video_id uuid references public.videos(id) on delete set null,
  channel_id uuid references public.youtube_channels(id) on delete set null,
  status text not null check (status in ('success', 'failed')),
  youtube_video_id text,
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.videos enable row level security;
alter table public.youtube_channels enable row level security;
alter table public.youtube_channel_tokens enable row level security;
alter table public.oauth_states enable row level security;
alter table public.upload_history enable row level security;

drop policy if exists "Users read own videos" on public.videos;
create policy "Users read own videos" on public.videos for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "Users add own videos" on public.videos;
create policy "Users add own videos" on public.videos for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "Users update own videos" on public.videos;
create policy "Users update own videos" on public.videos for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "Users delete own videos" on public.videos;
create policy "Users delete own videos" on public.videos for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Users read own channels" on public.youtube_channels;
create policy "Users read own channels" on public.youtube_channels for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "Users update own channels" on public.youtube_channels;
-- Channel changes are made only through the checked security-definer RPC below.

drop policy if exists "Users read own history" on public.upload_history;
create policy "Users read own history" on public.upload_history for select to authenticated using (user_id = (select auth.uid()));

-- Browser uploads are restricted to a folder named with the signed-in user's UUID.
drop policy if exists "Users upload own Shorts" on storage.objects;
create policy "Users upload own Shorts" on storage.objects for insert to authenticated
with check (bucket_id = 'shorts-videos' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists "Users read own Shorts" on storage.objects;
create policy "Users read own Shorts" on storage.objects for select to authenticated
using (bucket_id = 'shorts-videos' and owner_id = (select auth.uid()::text));
drop policy if exists "Users delete own Shorts" on storage.objects;
create policy "Users delete own Shorts" on storage.objects for delete to authenticated
using (bucket_id = 'shorts-videos' and owner_id = (select auth.uid()::text));

create or replace function public.set_active_youtube_channel(p_channel_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare owner_id uuid;
begin
  select user_id into owner_id from public.youtube_channels where id = p_channel_id;
  if owner_id is null or owner_id <> auth.uid() then raise exception 'Channel not found'; end if;
  update public.youtube_channels set active = false where user_id = auth.uid() and active;
  update public.youtube_channels set active = true where id = p_channel_id;
end;
$$;
revoke all on function public.set_active_youtube_channel(uuid) from public;
grant execute on function public.set_active_youtube_channel(uuid) to authenticated;

create or replace function public.delete_youtube_channel(p_channel_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.youtube_channels
    where id = p_channel_id and user_id = auth.uid()
  ) then
    raise exception 'Channel not found';
  end if;

  -- The encrypted token is removed by ON DELETE CASCADE. Existing video and
  -- history rows are retained with channel_id set to null.
  delete from public.youtube_channels where id = p_channel_id and user_id = auth.uid();
end;
$$;
revoke all on function public.delete_youtube_channel(uuid) from public;
grant execute on function public.delete_youtube_channel(uuid) to authenticated;

-- Remove expired OAuth state values whenever the migration is applied.
delete from public.oauth_states where expires_at < now();
