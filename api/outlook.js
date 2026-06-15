// api/outlook.js — Outlook email sync via Microsoft Graph API
// Replaces api/gmail.js from the personal tracker.

import Anthropic from "@anthropic-ai/sdk";
import { kv } from "@vercel/kv";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOKEN_KEY = "outlook_tokens";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── Token helpers ─────────────────────────────────────────────────────

async function getTokens() {
  return await kv.get(TOKEN_KEY);
}

async function saveTokens(tokens) {
  await kv.set(TOKEN_KEY, tokens);
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: "https://graph.microsoft.com/Mail.Read offline_access",
  });

  const res = await fetch(
    "https://login.microsoftonline.com/5618660f-3008-458d-9f44-ed60f5495a14/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  );

  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh failed: " + JSON.stringify(data));

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await saveTokens(tokens);
  return tokens;
}

async function getValidAccessToken() {
  let tokens = await getTokens();
  if (!tokens) throw { status: 401, error: "NOT_AUTHED" };

  if (Date.now() > tokens.expires_at - 60_000) {
    tokens = await refreshAccessToken(tokens.refresh_token);
  }
  return tokens.access_token;
}

// ── Graph API call ────────────────────────────────────────────────────

async function graphGet(path, accessToken) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Graph error ${res.status}: ${JSON.stringify(err)}`);
  }
  return res.json();
}

// ── Fetch emails with [task] in subject ──────────────────────────────

async function fetchTaskEmails(accessToken) {
  const filter = encodeURIComponent("contains(subject,'[task]')");
  const select = "id,subject,from,receivedDateTime,bodyPreview,body";
  const data = await graphGet(
    `/me/messages?$filter=${filter}&$select=${select}&$top=20&$orderby=receivedDateTime desc`,
    accessToken
  );

  return (data.value || []).map((msg) => ({
    id: msg.id,
    subject: msg.subject || "",
    from: msg.from?.emailAddress?.address || "",
    date: msg.receivedDateTime
      ? new Date(msg.receivedDateTime).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "",
    body: msg.body?.content
      ? msg.body.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : msg.bodyPreview || "",
  }));
}

// ── Parse email into task via Claude ─────────────────────────────────

async function parseEmailToTask(email, listIds) {
  const today = new Date().toISOString().split("T")[0];
  const prompt = `You are parsing an email into a structured task for a task tracker.

Email subject: ${email.subject}
Email body: ${(email.body || "").slice(0, 1000)}
Available list IDs: ${listIds.join(", ")}
Today's date: ${today}

Extract the task details and respond ONLY with valid JSON, no markdown:
{
  "name": "concise task name (strip [task] prefix)",
  "priority": "High|Medium|Low",
  "category": "short category or empty string",
  "deadlineDate": "YYYY-MM-DD or empty string",
  "doDate": "YYYY-MM-DD or empty string",
  "notes": "any relevant details from email body or empty string",
  "listId": "best matching list ID or first list ID"
}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].text.trim();
  return JSON.parse(raw);
}

// ── Handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, email, listIds } = req.body || {};

  try {
    if (action === "fetch") {
      let accessToken;
      try {
        accessToken = await getValidAccessToken();
      } catch (e) {
        if (e.status === 401) return res.status(401).json({ error: "NOT_AUTHED" });
        throw e;
      }

      const emails = await fetchTaskEmails(accessToken);
      return res.status(200).json({ emails });
    }

    if (action === "parse") {
      if (!email) return res.status(400).json({ error: "No email provided" });
      const task = await parseEmailToTask(email, listIds || []);
      return res.status(200).json({ task });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("Outlook API error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
