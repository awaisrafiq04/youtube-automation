import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) throw new Error("Sign in is required");
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user }, error } = await admin.auth.getUser(jwt);
    if (error || !user) throw new Error("Invalid dashboard session");
    const state = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const saved = await admin.from("oauth_states").insert({ state, user_id: user.id, expires_at: expiresAt });
    if (saved.error) throw saved.error;
    const callback = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-oauth-callback`;
    const params = new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, redirect_uri: callback,
      response_type: "code", access_type: "offline", prompt: "consent select_account",
      scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      state, include_granted_scopes: "true"
    });
    return Response.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: error.message || String(error) }, { status: 401, headers: corsHeaders });
  }
});

