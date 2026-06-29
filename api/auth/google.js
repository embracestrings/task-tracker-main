import { kv } from '@vercel/kv';

function tokenKey(workspaceId) {
  return `google_calendar_tokens_${workspaceId}`;
}

export default async function handler(req, res) {
  const { code, error, state: workspaceId } = req.query;
  const origin = `https://${req.headers.host}`;

  const close = (msg) =>
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
      window.opener && window.opener.postMessage('${msg}', '*');
      window.close();
    </script></body></html>`);

  if (error || !code || !workspaceId) return close('calendar_auth_error');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${origin}/api/auth/google`,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (tokens.error) return close('calendar_auth_error');

    await kv.set(tokenKey(workspaceId), {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });

    // Echo workspace ID back so the frontend knows which workspace was connected
    return close(`calendar_authed:${workspaceId}`);
  } catch (e) {
    return close('calendar_auth_error');
  }
}
