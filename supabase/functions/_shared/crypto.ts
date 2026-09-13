function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function encryptToken(token: string): Promise<{ ciphertext: string; iv: string }> {
  const rawKey = base64ToBytes(Deno.env.get("CHANNEL_TOKEN_ENCRYPTION_KEY") || "");
  if (rawKey.length !== 32) throw new Error("CHANNEL_TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

