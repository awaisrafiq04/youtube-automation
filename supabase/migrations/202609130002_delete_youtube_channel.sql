-- Allow a signed-in dashboard user to delete only their own connected channel.
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
