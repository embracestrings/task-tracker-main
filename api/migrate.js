import { kv } from '@vercel/kv';

// Reads from old work KV using raw REST API (separate credentials)
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
  // New workspace structure
  if (state.workspaces) {
    const out = {};
    for (const [wsId, ws] of Object.entries(state.workspaces)) {
      out[wsId] = {
        lists: (ws.lists || []).map(l => ({ id: l.id, name: l.name, tasks: (ws.tasks || []).filter(t => t.listId === l.id).length })),
        totalTasks: (ws.tasks || []).length,
        ideas: (ws.ideas || []).map(i => ({ id: i.id, name: i.name, notes: ((ws.notes || []).filter(n => n.spaceId === i.id)).length })),
      };
    }
    return { structure: 'workspace', workspaces: out };
  }
  // Old flat structure
  return {
    structure: 'flat',
    lists: (state.lists || []).map(l => ({ id: l.id, name: l.name, tasks: (state.tasks || []).filter(t => t.listId === l.id).length })),
    totalTasks: (state.tasks || []).length,
    ideas: (state.ideas || []).map(i => ({ id: i.id, name: i.name })),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action } = req.body || {};

  // ── Preview: show what's in both KV stores ──────────────────────────
  if (action === 'preview') {
    const [newState, oldState] = await Promise.all([
      kv.get('tracker_state'),
      getOldState(),
    ]);
    return res.json({
      personal_kv: summarize(newState),
      work_kv: summarize(oldState),
    });
  }

  return res.status(400).json({ error: 'Unknown action. Use: preview' });
}
