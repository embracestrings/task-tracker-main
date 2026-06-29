import { kv } from '@vercel/kv';

async function getAccessToken() {
  const stored = await kv.get('google_calendar_tokens');
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
    await kv.set('google_calendar_tokens', stored);
  }

  return stored.access_token;
}

function buildEvent(task) {
  const date = task.doDate || task.deadlineDate;
  const time = task.doDate ? task.doTime : task.deadlineTime;

  let start, end;
  if (time) {
    const startDt = new Date(`${date}T${time}:00`);
    const endDt = new Date(startDt.getTime() + 60 * 60 * 1000); // +1 hour
    start = { dateTime: startDt.toISOString() };
    end = { dateTime: endDt.toISOString() };
  } else {
    // All-day: Google requires end = next day
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const nextDay = d.toISOString().slice(0, 10);
    start = { date };
    end = { date: nextDay };
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
  const { action } = req.body;

  // ── Auth URL ──────────────────────────────────────────────────────
  if (action === 'auth_url') {
    const origin = req.body.origin || `https://${req.headers.host}`;
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: `${origin}/api/auth/google`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.events',
      access_type: 'offline',
      prompt: 'consent',
    });
    return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }

  // ── Status ────────────────────────────────────────────────────────
  if (action === 'status') {
    const tokens = await kv.get('google_calendar_tokens');
    return res.json({ connected: !!tokens });
  }

  // ── Disconnect ────────────────────────────────────────────────────
  if (action === 'disconnect') {
    await kv.del('google_calendar_tokens');
    return res.json({ ok: true });
  }

  // ── Sync ──────────────────────────────────────────────────────────
  if (action === 'sync') {
    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(401).json({ error: 'NOT_AUTHED' });

    const { tasks } = req.body;
    const results = { created: 0, updated: 0, deleted: 0, errors: 0 };
    const updatedTasks = [];

    for (const task of tasks) {
      try {
        const event = buildEvent(task);

        if (task.calendarEventId) {
          // Update existing event
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
            // Event deleted from Calendar side — re-create it
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
          // Create new event
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

  // ── Delete event (when task is deleted/done) ──────────────────────
  if (action === 'delete') {
    const accessToken = await getAccessToken();
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
