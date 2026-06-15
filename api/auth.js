// api/auth.js — Microsoft OAuth callback handler
// Exchanges the auth code for tokens and stores them in KV.

import { kv } from "@vercel/kv";

const TOKEN_KEY = "outlook_tokens";

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <html><body>
        <p>Auth error: ${error}</p>
        <script>window.opener?.postMessage('outlook_auth_error', '*'); window.close();</script>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).send("Missing code parameter");
  }

  try {
    const redirectUri = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}/api/auth`;

    const params = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: "https://graph.microsoft.com/Mail.Read offline_access",
    });

    const tokenRes = await fetch(
      "https://login.microsoftonline.com/5618660f-3008-458d-9f44-ed60f5495a14/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      }
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      throw new Error("No access token returned: " + JSON.stringify(tokenData));
    }

    await kv.set(TOKEN_KEY, {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + tokenData.expires_in * 1000,
    });

    return res.status(200).send(`
      <html><body>
        <p>Outlook connected! You can close this window.</p>
        <script>window.opener?.postMessage('outlook_authed', '*'); window.close();</script>
      </body></html>
    `);
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(500).send(`
      <html><body>
        <p>Auth failed: ${err.message}</p>
        <script>window.opener?.postMessage('outlook_auth_error', '*'); window.close();</script>
      </body></html>
    `);
  }
}
