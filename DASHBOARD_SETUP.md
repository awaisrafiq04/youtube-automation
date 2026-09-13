# Secure dashboard setup

The dashboard is hosted by GitHub Pages, signs in through Supabase Auth, and uses Row Level Security for all browser access. Google client secrets and refresh tokens never reach the browser.

## 1. Apply the database migration

Open Supabase **SQL Editor → New query**, copy the complete contents of `supabase/migrations/202609130001_dashboard.sql`, and run it once.

## 2. Create the only dashboard user

1. Open Supabase **Authentication → Users → Add user → Create new user**.
2. Enter the private email and a new strong password used only for this dashboard.
3. Enable **Auto confirm user**, then create the user.
4. Copy the user's UUID from the Users table.
5. In **Authentication → Sign In / Providers → Email**, disable new-user signups. Do not disable email/password sign-in.

Assign the existing two video rows to this user in SQL Editor, replacing the placeholder with the copied UUID:

```sql
update public.videos
set user_id = 'YOUR-AUTH-USER-UUID'
where user_id is null;
```

## 3. Configure the GitHub Pages frontend

In GitHub, open **Settings → Secrets and variables → Actions → Variables** (not Secrets) and add:

```text
SUPABASE_URL                 https://YOUR-PROJECT-REF.supabase.co
SUPABASE_PUBLISHABLE_KEY     sb_publishable_...
```

The publishable key is designed for browser use. RLS protects the data. Never put an `sb_secret_...` key in a repository variable.

Run **Actions → Publish OAuth information site → Run workflow**. The login page will be available at:

```text
https://awaisrafiq04.github.io/youtube-automation/
```

In Supabase **Authentication → URL Configuration**, set the Site URL to that address and add it to Redirect URLs.

## 4. Create a Google Web OAuth client

Keep the existing Desktop OAuth client as the legacy fallback. In the same production Google Cloud project:

1. Open **Google Auth Platform → Data access** and add both scopes:
   - `https://www.googleapis.com/auth/youtube.upload`
   - `https://www.googleapis.com/auth/youtube.readonly`
2. Open **Google Auth Platform → Clients → Create client**.
3. Choose **Web application** and name it `Shorts Control Room`.
4. Add this exact authorized redirect URI, replacing the project reference:

```text
https://YOUR-PROJECT-REF.supabase.co/functions/v1/google-oauth-callback
```

5. Create the client and securely copy its client ID and secret. Do not put either value in GitHub Pages code.

## 5. Create an encryption key

Run locally:

```bash
openssl rand -base64 32
```

Save the output securely as `CHANNEL_TOKEN_ENCRYPTION_KEY`. The same value must be present in Supabase Edge Function secrets and GitHub Actions secrets. Losing it makes stored channel tokens unreadable. Never rotate it without reconnecting every channel.

## 6. Deploy the Edge Functions

Install and authenticate the Supabase CLI, then link this repository to the project:

```bash
brew install supabase/tap/supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF
```

Create `supabase/.env.functions` locally (it is ignored by Git) containing:

```env
GOOGLE_CLIENT_ID=your-web-client-id
GOOGLE_CLIENT_SECRET=your-web-client-secret
CHANNEL_TOKEN_ENCRYPTION_KEY=your-base64-key
DASHBOARD_URL=https://awaisrafiq04.github.io/youtube-automation/
DASHBOARD_ORIGIN=https://awaisrafiq04.github.io
```

Upload the secrets and deploy both functions:

```bash
supabase secrets set --env-file supabase/.env.functions
supabase functions deploy google-oauth-start
supabase functions deploy google-oauth-callback --no-verify-jwt
```

Delete the local `supabase/.env.functions` file after confirming deployment. The function receives `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically from Supabase.

## 7. Configure GitHub Actions for connected channels

In GitHub **Settings → Secrets and variables → Actions → Secrets**, add:

```text
CHANNEL_TOKEN_ENCRYPTION_KEY   the same base64 key from step 5
DASHBOARD_USER_ID              the Supabase Auth user UUID from step 2
```

Keep the existing YouTube client ID, client secret, and refresh token secrets as a fallback until the first dashboard-connected channel succeeds.

## 8. Connect and test a channel

1. Open the dashboard and sign in.
2. Open **Channels → Connect channel**.
3. Authorize the intended YouTube account/channel through Google.
4. Confirm the channel card appears and is marked Active.
5. Upload a small MP4 from **Videos**, keeping privacy set to Private.
6. Manually run GitHub Actions with `count: 1` and the desired repeat setting.
7. Confirm the upload appears in YouTube Studio and in the dashboard History view.

Connecting another channel repeats step 2 above. Use **Make active** to choose the destination for future workflow runs.

## Security model

- GitHub Pages receives only the public Supabase URL and publishable key.
- Supabase Auth handles the password; no password is stored in HTML or GitHub.
- RLS limits dashboard rows and Storage objects to the signed-in user.
- Google client secrets exist only in Supabase Edge Function secrets.
- Refresh tokens are AES-256-GCM encrypted before database storage.
- The token table has RLS enabled and no browser-access policy.
- GitHub Actions decrypts only the active channel token at runtime using a repository secret.

