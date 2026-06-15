// api/sync.js — Cloud sync via Upstash Redis (KV)
import { kv } from "@vercel/kv";

const STATE_KEY = "tracker_state";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action } = req.body || {};

  try {
    if (action === "save" || action === "push") {
      const payload = req.body.state || req.body.data;
      if (!payload) return res.status(400).json({ error: "No data provided" });
      await kv.set(STATE_KEY, payload);
      return res.status(200).json({ ok: true });
    }

    if (action === "load" || action === "pull") {
      const state = await kv.get(STATE_KEY);
      return res.status(200).json({ state: state || null });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("Sync error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
