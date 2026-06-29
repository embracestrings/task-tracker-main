import { kv } from '@vercel/kv';

function tokenKey(workspaceId) {
  return `google_calendar_tokens_${workspaceId}`;
}

async function getAccessToken(workspaceId) {
  const stored = await kv.get(tokenKey(workspaceId));
  if (!stored) return null;

  // Refresh if expiring within 60 seconds
  if (stored.expires_at - Date.now() < 60_000) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: stored.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const fresh = await res.json();
    if (fresh.error) return null;
    stored.access_token = fresh.access_token;
    stored.expires_at = Date.now() + fresh.expires_in * 1000;
    await kv.set(tokenKey(workspaceId), stored);
  }

  return stored.access_token;
}

function buildEvent(task) {
  const date = task.doDate || task.deadlineDate;
  const time = task.doDate ? task.doTime : task.deadlineTime;

  let start, end;
  if (time) {
    const startDt = new Date(`${date}T${time}:00`);
    const endDt = new Date(startDt.getTime() + 60 * 60 * 1000);
    start = { dateTime: startDt.toISOString() };
    end = { dateTime: endDt.toISOString() };
  } else {
    // All-day: Google requires end = next day
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + 1);
    start = { date };
    end = { date: d.toISOString().slice(0, 10) };
  }

  const parts = [];
  if (task.doDate && task.deadlineDate && task.doDate !== task.deadlineDate) {
    parts.push(`Deadline: ${task.deadlineDate}${task.deadlineTime ? ' ' + task.deadlineTime : ''}`);
  }
  if (task.notes) parts.push(task.notes);
  if (task.priority && task.priority !== 'Medium') parts.push(`Priority: ${task.priority}`);

  return { summary: task.name, description: parts.join('\n') || undefined, start, end };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action, workspaceId } = req.body;

  // ── Auth URL ──────────────────────────────────────────────────────
  if (action === 'auth_url') {
    if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
    const origin = req.body.origin || `https://${req.headers.host}`;
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: `${origin}/api/auth/google`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.events',
      access_type: 'offline',
      prompt: 'consent',
      state: workspaceId,
    });
    return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }

  // ── Status (single workspace) ─────────────────────────────────────
  if (action === 'status') {
    if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
    const tokens = await kv.get(tokenKey(workspaceId));
    return res.json({ connected: !!tokens });
  }

  // ── Status (all workspaces at once) ──────────────────────────────
  if (action === 'status_all') {
    const { workspaceIds } = req.body;
    if (!Array.isArray(workspaceIds)) return res.status(400).json({ error: 'Missing workspaceIds' });
    const results = {};
    await Promise.all(workspaceIds.map(async id => {
      const tokens = await kv.get(tokenKey(id));
      results[id] = !!tokens;
    }));
    return res.json({ connected: results });
  }

  // ── Disconnect ────────────────────────────────────────────────────
  if (action === 'disconnect') {
    if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
    await kv.del(tokenKey(workspaceId));
    return res.json({ ok: true });
  }

  // ── Sync ──────────────────────────────────────────────────────────
  if (action === 'sync') {
    if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
    const accessToken = await getAccessToken(workspaceId);
    if (!accessToken) return res.status(401).json({ error: 'NOT_AUTHED' });

    const { tasks } = req.body;
    const results = { created: 0, updated: 0, errors: 0 };
    const updatedTasks = [];

    for (const task of tasks) {
      try {
        const event = buildEvent(task);

        if (task.calendarEventId) {
          const r = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${task.calendarEventId}`,
            {
              method: 'PUT',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(event),
            }
          );
          if (r.ok) { results.updated++; updatedTasks.push(task); }
          else if (r.status === 404) {
            // Re-create if deleted from Calendar side
            const cr = await fetch(
              'https://www.googleapis.com/calendar/v3/calendars/primary/events',
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(event),
              }
            );
            if (cr.ok) {
              const created = await cr.json();
              results.created++;
              updatedTasks.push({ ...task, calendarEventId: created.id });
            } else { results.errors++; updatedTasks.push(task); }
          } else { results.errors++; updatedTasks.push(task); }
        } else {
          const r = await fetch(
            'https://www.googleapis.com/calendar/v3/calendars/primary/events',
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(event),
            }
          );
          if (r.ok) {
            const created = await r.json();
            results.created++;
            updatedTasks.push({ ...task, calendarEventId: created.id });
          } else { results.errors++; updatedTasks.push(task); }
        }
      } catch (e) {
        results.errors++;
        updatedTasks.push(task);
      }
    }

    return res.json({ ...results, tasks: updatedTasks });
  }

  // ── Delete a single event ─────────────────────────────────────────
  if (action === 'delete') {
    if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
    const accessToken = await getAccessToken(workspaceId);
    if (!accessToken) return res.status(401).json({ error: 'NOT_AUTHED' });
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ error: 'Missing eventId' });
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
