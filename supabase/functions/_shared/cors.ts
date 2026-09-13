export const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("DASHBOARD_ORIGIN") || "https://awaisrafiq04.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
