# Supabase → YouTube Shorts uploader

This project uploads finished MP4 files exactly as stored—there is no audio mixing or media transformation. Supabase Storage holds the files, the `videos` table is the sole upload manifest, Pipedream schedules each run, and GitHub Actions performs the upload.

## OAuth information site

The `docs` directory contains the public application homepage and privacy policy required to move a personal external Google OAuth app from Testing to Production. The `pages.yml` workflow publishes it with GitHub Pages.

After pushing the repository, open **GitHub repository → Settings → Pages** and select **GitHub Actions** as the source. Run **Actions → Publish OAuth information site** if it does not deploy automatically. For a repository named `REPOSITORY` owned by `USERNAME`, use these URLs in **Google Auth Platform → Branding**:

```text
Application homepage: https://USERNAME.github.io/REPOSITORY/
Privacy policy:       https://USERNAME.github.io/REPOSITORY/privacy.html
```

Save the Branding form, return to **Audience**, and publish the app. Then run `scripts/get_refresh_token.py` again and replace the refresh token in `.env` and GitHub Actions secrets. Do not upload an app logo unless you intend to complete Google's additional branding-verification process.

## 1. Configure Supabase

In the Supabase dashboard, create a **private** Storage bucket named `shorts-videos`. Keep it private: the service-role key used by the server-side workflow can read it without making files public.

Run this exact statement in the SQL editor:

```sql
create extension if not exists pgcrypto;

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  title text not null,
  description text not null default '',
  tags text[] not null default array[]::text[],
  category_id text not null default '22',
  privacy_status text not null default 'public'
    check (privacy_status in ('public', 'private', 'unlisted')),
  posted boolean not null default false,
  posted_at timestamptz,
  youtube_video_id text,
  created_at timestamptz not null default now()
);

create index videos_upload_queue_idx
  on public.videos (posted, created_at, id);
```

The added `created_at` column provides a stable queue order; `id` breaks timestamp ties. Enable Row Level Security if the table is used by any client application. The uploader uses a service-role key server-side, which bypasses RLS. Never put that key in browser or mobile code.

Upload a finished `.mp4` to Storage → `shorts-videos`, for example at `incoming/example-short.mp4`. Then insert its manifest row:

```sql
insert into public.videos
  (storage_path, title, description, tags, category_id, privacy_status, posted)
values
  ('incoming/example-short.mp4',
   'My first vertical video #Shorts',
   'A short description.',
   array['Shorts', 'example'],
   '22',
   'private',
   false);
```

Starting with `private` is recommended for the first end-to-end test. The script adds `#Shorts` to a title and `Shorts` to tags if either marker is absent.

## 2. Configure Google and YouTube OAuth

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **YouTube Data API v3** under APIs & Services → Library.
3. Configure the OAuth consent screen. While the app is in testing, add the uploading Google/YouTube account as a test user.
4. Under APIs & Services → Credentials, create an **OAuth client ID** with application type **Desktop app**.
5. Copy the client ID and client secret. Do not commit them.

Create and activate a local environment (Python 3.10 or newer), install dependencies, and export the Desktop client credentials:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export YOUTUBE_CLIENT_ID='your-client-id.apps.googleusercontent.com'
export YOUTUBE_CLIENT_SECRET='your-client-secret'
python scripts/get_refresh_token.py
```

A browser opens. Sign in to the YouTube channel owner account and approve upload access. The script prints `YOUTUBE_REFRESH_TOKEN=...`. Treat that value like a password. `prompt=consent` and offline access are requested so Google returns a refresh token.

## 3. Test locally

Copy `.env.example` to `.env`, fill in all values, and keep the file uncommitted. This project deliberately does not add a dotenv dependency, so load it into the shell before running:

```bash
set -a
source .env
set +a
python scripts/upload.py --count 1
```

Use a test manifest row with `privacy_status = 'private'`. Confirm the video appears in YouTube Studio and that Supabase immediately records `posted = true`, `posted_at`, and `youtube_video_id`. If an upload or manifest update fails, the command logs the exception, continues with the remaining selected rows, and exits non-zero after the batch.

Important: if YouTube accepts an upload but the subsequent Supabase update fails, the row remains unposted and may be uploaded again on the next run. Use the logged YouTube ID to reconcile that row before retrying.

## 4. Add GitHub Actions secrets

Push the repository to GitHub. In **Settings → Secrets and variables → Actions → New repository secret**, add:

- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service-role key exists only in local trusted testing and GitHub Actions—not in Pipedream, public logs, or client-side code. Run **Actions → Upload YouTube Shorts → Run workflow** once with `count` set to `1`.

## 5. Trigger from Pipedream

Create a Pipedream workflow with a **Schedule** trigger. Choose cron and run twice daily (for example `0 8,20 * * *`; confirm the workflow timezone in Pipedream). Store a fine-grained GitHub personal access token as the Pipedream secret/environment variable `GITHUB_TOKEN`; grant it access to this repository with **Actions: Read and write**. A classic PAT needs the `repo` scope for a private repository.

Add an HTTP or Node.js action that sends this request (replace owner, repository, and branch):

```bash
curl --fail-with-body --request POST \
  --url 'https://api.github.com/repos/OWNER/REPO/actions/workflows/upload-shorts.yml/dispatches' \
  --header 'Accept: application/vnd.github+json' \
  --header "Authorization: Bearer ${GITHUB_TOKEN}" \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  --header 'Content-Type: application/json' \
      --data '{"ref":"main","inputs":{"count":"1","repeat":true}}'
```

The equivalent HTTP shape is:

```http
POST /repos/OWNER/REPO/actions/workflows/upload-shorts.yml/dispatches HTTP/1.1
Host: api.github.com
Accept: application/vnd.github+json
Authorization: Bearer <PIPEDREAM_GITHUB_TOKEN_SECRET>
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json

{"ref":"main","inputs":{"count":"1","repeat":true}}
```

A successful dispatch returns HTTP `204 No Content`. The dispatch response does not wait for the run to finish. If Pipedream must alert on the final result, add follow-up steps that find the newly created workflow run and poll its status/conclusion, or use a separate GitHub `workflow_run` notification path.

### Two uploads every day at 09:00 and 20:00

For two stored videos that should repeat indefinitely, set the Pipedream Schedule trigger to `0 9,20 * * *`, choose the intended timezone in Pipedream, and dispatch with `count` set to `1` and `repeat` set to `true`, exactly as in the request above. At 09:00 the uploader chooses the never-posted or least-recently posted row; at 20:00 it chooses the other row. The following morning it cycles back to the first.

Repeat mode does not reset `posted`. Instead, it treats `posted_at` as the last-run timestamp and updates `youtube_video_id` to the newest upload ID. Without `repeat: true`, the original one-time queue behavior remains unchanged and only `posted = false` rows are selected.

## 6. Add videos going forward

For every new Short:

1. Upload the final `.mp4`, with its existing audio, to the private `shorts-videos` bucket.
2. Insert one `videos` row with the exact `storage_path`, title, description, and tags; leave `posted = false`.
3. Include `#Shorts` in the title and `Shorts` in tags. The uploader also enforces these markers.

Do not maintain a local JSON queue. Supabase is the only manifest and source of posted state.

## Quota note

YouTube Data API projects commonly receive 10,000 quota units per day. Historically, `videos.insert` has been documented at 1,600 units, so two uploads per day would consume about 3,200 units and fit comfortably. Google can change quota costs and project allocations; confirm the current `videos.insert` cost in the official quota calculator/console for your project.

## Operational behavior

- Default batch size is two; pass `--count N` or the workflow `count` input to change it.
- Rows are selected where `posted = false`, ordered by `created_at`, then `id`.
- Each MP4 is downloaded to an OS temporary file and uploaded resumably in 8 MiB chunks.
- A successful upload is recorded immediately before the next row starts.
- Temporary files are removed in a `finally` block after every attempt.
- Per-video failures do not stop the batch, but any failure makes the process exit with status 1.
- GitHub Actions concurrency prevents two workflow runs from uploading the same queued row concurrently.
