import { kv } from '@vercel/kv';

async function getOldState() {
  const url = process.env.OLD_KV_REST_API_URL;
  const token = process.env.OLD_KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('OLD_KV_REST_API_URL / OLD_KV_REST_API_TOKEN not set');
  const res = await fetch(`${url}/get/tracker_state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.result ? (typeof data.result === 'string' ? JSON.parse(data.result) : data.result) : null;
}

function summarize(state) {
  if (!state) return null;
  if (state.workspaces) {
    const out = {};
    for (const [wsId, ws] of Object.entries(state.workspaces)) {
      out[wsId] = {
        lists: (ws.lists || []).map(l => ({ id: l.id, name: l.name, tasks: (ws.tasks || []).filter(t => t.listId === l.id).length })),
        totalTasks: (ws.tasks || []).length,
        ideas: (ws.ideas || []).map(i => ({ id: i.id, name: i.name, notes: (ws.notes || []).filter(n => n.spaceId === i.id).length })),
      };
    }
    return { structure: 'workspace', workspaces: out };
  }
  return {
    structure: 'flat',
    lists: (state.lists || []).map(l => ({ id: l.id, name: l.name, tasks: (state.tasks || []).filter(t => t.listId === l.id).length })),
    totalTasks: (state.tasks || []).length,
  };
}

// Merge src workspace data into dest workspace (ID-based dedup)
function mergeWorkspace(dest, src) {
  const byId = (arr) => new Set((arr || []).map(x => x.id));

  const existingLists = byId(dest.lists);
  dest.lists = [...(dest.lists || []), ...(src.lists || []).filter(l => !existingLists.has(l.id))];

  const existingTasks = byId(dest.tasks);
  dest.tasks = [...(dest.tasks || []), ...(src.tasks || []).filter(t => !existingTasks.has(t.id))];

  const existingIdeas = byId(dest.ideas);
  dest.ideas = [...(dest.ideas || []), ...(src.ideas || []).filter(i => !existingIdeas.has(i.id))];

  const existingNotes = byId(dest.notes);
  dest.notes = [...(dest.notes || []), ...(src.notes || []).filter(n => !existingNotes.has(n.id))];

  dest.manualOrders = { ...(src.manualOrders || {}), ...(dest.manualOrders || {}) };
  dest.completedCollapsed = { ...(src.completedCollapsed || {}), ...(dest.completedCollapsed || {}) };

  return dest;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action } = req.body || {};

  // ── Preview ─────────────────────────────────────────────────────────
  if (action === 'preview') {
    const [newState, oldState] = await Promise.all([
      kv.get('tracker_state'),
      getOldState(),
    ]);
    return res.json({ personal_kv: summarize(newState), work_kv: summarize(oldState) });
  }

  // ── Run migration ────────────────────────────────────────────────────
  if (action === 'run') {
    const [personalState, workState] = await Promise.all([
      kv.get('tracker_state'),
      getOldState(),
    ]);

    if (!workState) return res.status(400).json({ error: 'Could not read work KV' });
    if (!personalState) return res.status(400).json({ error: 'Could not read personal KV' });

    const merged = JSON.parse(JSON.stringify(personalState)); // deep clone

    // Merge each workspace from work KV into personal KV
    for (const wsId of Object.keys(workState.workspaces || {})) {
      if (!merged.workspaces[wsId]) continue; // skip if workspace doesn't exist in personal
      merged.workspaces[wsId] = mergeWorkspace(merged.workspaces[wsId], workState.workspaces[wsId]);
    }

    await kv.set('tracker_state', merged);

    return res.json({ ok: true, summary: summarize(merged) });
  }

  return res.status(400).json({ error: 'Unknown action. Use: preview | run' });
}
