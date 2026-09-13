import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { encryptToken } from "../_shared/crypto.ts";

const dashboard = () => Deno.env.get("DASHBOARD_URL") || "https://awaisrafiq04.github.io/youtube-automation/";
const redirectError = (message: string) => Response.redirect(`${dashboard()}?oauth_error=${encodeURIComponent(message)}`, 302);

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url), code = url.searchParams.get("code"), state = url.searchParams.get("state");
    if (url.searchParams.get("error")) return redirectError(url.searchParams.get("error")!);
    if (!code || !state) return redirectError("Missing OAuth response values");
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const found = await admin.from("oauth_states").select("user_id,expires_at").eq("state", state).maybeSingle();
    await admin.from("oauth_states").delete().eq("state", state);
    if (found.error || !found.data || new Date(found.data.expires_at) <= new Date()) return redirectError("OAuth request expired; try again");
    const callback = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-oauth-callback`;
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!, redirect_uri: callback, grant_type: "authorization_code" }) });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.refresh_token) throw new Error(tokens.error_description || "Google did not return a refresh token");
    const channelResponse = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const channelBody = await channelResponse.json(), item = channelBody.items?.[0];
    if (!channelResponse.ok || !item) throw new Error("No YouTube channel was found for this account");
    const existing = await admin.from("youtube_channels").select("id,active").eq("user_id", found.data.user_id).eq("youtube_channel_id", item.id).maybeSingle();
    const anyActive = await admin.from("youtube_channels").select("id").eq("user_id", found.data.user_id).eq("active", true).maybeSingle();
    const channelData = { user_id: found.data.user_id, youtube_channel_id: item.id, display_name: item.snippet.title, thumbnail_url: item.snippet.thumbnails?.default?.url || null, active: existing.data?.active || !anyActive.data };
    const saved = await admin.from("youtube_channels").upsert(channelData, { onConflict: "user_id,youtube_channel_id" }).select("id").single();
    if (saved.error) throw saved.error;
    const encrypted = await encryptToken(tokens.refresh_token);
    const tokenSaved = await admin.from("youtube_channel_tokens").upsert({ channel_id: saved.data.id, token_ciphertext: encrypted.ciphertext, token_iv: encrypted.iv, updated_at: new Date().toISOString() });
    if (tokenSaved.error) throw tokenSaved.error;
    return Response.redirect(`${dashboard()}?channel=connected`, 302);
  } catch (error) { return redirectError(error.message || String(error)); }
});

