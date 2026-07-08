// api/sync.js — Cloud sync via Upstash Redis (KV)
import { kv } from "@vercel/kv";

const STATE_KEY = "tracker_state";
const BACKUP_KEY = "tracker_state_backup";

// Count how much top-level personal data is in a state object
function topLevelCount(s) {
  if (!s) return 0;
  return (s.ruleItems?.length || 0) +
         (s.reflections?.length || 0) +
         (s.goals?.personal?.length || 0) +
         (s.goals?.professional?.length || 0);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action } = req.body || {};

  try {
    if (action === "save" || action === "push") {
      const payload = req.body.state || req.body.data;
      if (!payload) return res.status(400).json({ error: "No data provided" });

      const existing = await kv.get(STATE_KEY);
      const existingCount = topLevelCount(existing);
      const newCount = topLevelCount(payload);

      if (existing && existingCount > 0) {
        // Always snapshot the previous state before overwriting
        await kv.set(BACKUP_KEY, existing);

        // Safety guard: never silently wipe real data with empty defaults.
        // If incoming has zero top-level data but existing has some, merge it in.
        if (newCount === 0) {
          payload.goals      = existing.goals;
          payload.ruleItems  = existing.ruleItems;
          payload.ruleChecks = existing.ruleChecks;
          payload.reflections = existing.reflections;
          payload.prompts    = existing.prompts;
        }
      }

      await kv.set(STATE_KEY, payload);
      return res.status(200).json({ ok: true });
    }

    if (action === "load" || action === "pull") {
      const state = await kv.get(STATE_KEY);
      return res.status(200).json({ state: state || null });
    }

    if (action === "peek_backup") {
      const backup = await kv.get(BACKUP_KEY);
      const main   = await kv.get(STATE_KEY);
      return res.status(200).json({
        backup: backup ? {
          ruleItemsCount:      backup.ruleItems?.length || 0,
          reflectionsCount:    backup.reflections?.length || 0,
          goalsPersonal:       backup.goals?.personal?.length || 0,
          goalsProfessional:   backup.goals?.professional?.length || 0,
          ruleChecksCount:     backup.ruleChecks?.length || 0,
        } : null,
        main: main ? {
          ruleItemsCount:      main.ruleItems?.length || 0,
          reflectionsCount:    main.reflections?.length || 0,
          goalsPersonal:       main.goals?.personal?.length || 0,
          goalsProfessional:   main.goals?.professional?.length || 0,
          ruleChecksCount:     main.ruleChecks?.length || 0,
        } : null,
      });
    }

    if (action === "restore_backup") {
      const backup = await kv.get(BACKUP_KEY);
      if (!backup) return res.status(404).json({ error: "No backup found" });
      // Snapshot current state before restoring so restore itself is undoable
      const current = await kv.get(STATE_KEY);
      if (current) await kv.set(BACKUP_KEY + "_pre_restore", current);
      await kv.set(STATE_KEY, backup);
      return res.status(200).json({ ok: true, restored: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("Sync error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
