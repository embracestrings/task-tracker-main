# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal task tracker PWA (Progressive Web App) for Turner. It runs at `tasks.embracestrings.com`, deploys via Vercel (personal account: `embracestrings`), and uses Upstash Redis (via `@vercel/kv`) as the cloud datastore. The entire frontend is a single `index.html` file — no build step, no framework.

## Deployment

Push to `main` on `github.com/embracestrings/task-tracker-main` → Vercel auto-deploys.

```bash
git add <files>
git commit -m "description"
git push
```

There is no local dev server. Test UI changes by pushing and checking the live URL, or open `index.html` directly in a browser (API calls will fail locally but UI layout works).

## Architecture

### Frontend (`index.html`)
Single-file vanilla JS app. All CSS, HTML template strings, and JS live in one file (~1700 lines). No bundler, no framework.

**State shape:**
```js
state = {
  activeWorkspace: 'velocitytx',
  workspaceOrder: ['velocitytx', 'embrace', 'personal', 'acu'],
  workspaces: {
    [wsId]: {
      name, color,
      lists: [...],      // each: { id, name, color }
      tasks: [...],      // each: { id, name, listId, doDate, doTime, deadlineDate, deadlineTime, recurrence, notes, parentId, completedAt }
      ideas: [...],      // each: { id, name, color }
      notes: [...],      // idea space notes: { id, spaceId, text, createdAt }
      manualOrders: {},  // listId → [taskId, ...]
      completedCollapsed: {},
      activeList: 'tasks',
    }
  }
}
```

`ws()` always returns `state.workspaces[state.activeWorkspace]` — use it everywhere instead of accessing state directly.

**Persistence flow:**
1. On load: read localStorage (`tracker_state_v4`) → render immediately
2. Then fetch `/api/sync` (cloud) → merge → re-render. Cloud always wins.
3. On every mutation: debounced save to localStorage + async push to `/api/sync`
4. On `visibilitychange` (app comes to foreground): re-runs `load()` to pick up changes from other devices, skips if a modal is open.

**Rendering:** All UI is rebuilt via `innerHTML` on `render()`. No virtual DOM, no diffing. Call `render()` after any state mutation. Sub-renders: `renderSidebar()`, `renderContent()`, `renderHeaderStats()`.

**Brand palette** (Embrace Strings):
- Deep Blue `#16335B` → `--accent`
- Cream `#F2F2F3` → `--bg`
- Gold `#BA9E78` → `--gold`

### Backend (`api/*.js`)
Vercel serverless functions. All use ES module syntax (`import/export`). No shared utilities — each file is self-contained.

| File | Purpose |
|------|---------|
| `api/sync.js` | Load/save full state to KV under key `tracker_state` |
| `api/calendar.js` | Google Calendar OAuth + event sync. Actions: `auth_url`, `status`, `status_all`, `sync`, `delete`, `disconnect` |
| `api/auth/google.js` | OAuth callback — exchanges code for tokens, stores under `google_calendar_tokens_${workspaceId}` |
| `api/outlook.js` | Gmail/Outlook email import |
| `api/migrate.js` | One-time migration utility — **delete this file when migration is complete** |

### PWA / iOS specifics
- `viewport-fit=cover` + `env(safe-area-inset-*)` for notch/home indicator
- Body height: `calc(100dvh + env(safe-area-inset-bottom, 0px))` — iOS excludes home indicator from `dvh`, this compensates
- Service worker (`sw.js`): network-first for HTML navigation (picks up Vercel deploys), cache-first for static assets
- Auto-update: `visibilitychange` triggers `reg.update()` (new code) + `load()` (new data) when app is foregrounded

### Google Calendar sync
- Only syncs workspaces in `SYNC_WORKSPACES = ['embrace', 'personal', 'acu']` — VelocityTX never syncs
- Per-workspace tokens: each workspace connects to a different Gmail account
- Auto-syncs on task create/edit (`autoSyncTask`), auto-removes on delete (`autoRemoveTask`)
- Tasks without dates are never synced; done tasks are never synced

## Key conventions

- **No status, priority, or category fields** — these were removed. Don't add them back.
- **No filter toolbar** — removed. Don't re-add filtering UI.
- **No header stats** (total/done/overdue counts) — removed. `renderHeaderStats()` only updates the Today sidebar badge.
- Task fields that exist: `name`, `listId`, `doDate`, `doTime`, `deadlineDate`, `deadlineTime`, `recurrence`, `notes`, `parentId`, `completedAt`, `calendarEventId`
- Edit buttons for lists/ideas are on the **page header**, not the sidebar. Workspace edit buttons remain in the sidebar.

## Environment variables (Vercel)

| Variable | Purpose |
|----------|---------|
| `KV_REST_API_URL` | Upstash Redis URL (auto-set by Vercel KV integration) |
| `KV_REST_API_TOKEN` | Upstash Redis token (auto-set) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

## Rey Family Travel Map (`trips.embracestrings.com`)

A password-protected family travel map ("trips atlas" in code) that shares this Vercel project. It doesn't touch the main app.

- **Pages:** `trips/index.html` (display: map, day rail, lightbox, idle slideshow) and `trips/admin.html` (itinerary editor + bulk photo upload). Shared code lives in `trips/atlas.js` and `trips/atlas.css`. MapLibre and exifr are vendored in `trips/vendor/`.
- **Routing:** `vercel.json` `routes` maps `/` and `/admin` on the `trips.embracestrings.com` host to those pages. On any other host they are at `/trips/` and `/trips/admin`.
- **API:** `api/trips.js` is one function with an `action` query param (login, data, saveTrip, upload, photo, geocode, invite, acceptInvite, updateProfile, avatar, …). Sessions are HMAC-signed HttpOnly cookies (`<personId>.<expiry>.<sig>`, keyed off `TRIPS_PASSWORD`).
- **Accounts:** everyone signs in with email + password; everyone can see every trip. Accounts exist so trips show who went (`trip.travelers` = person ids, `trip.family` = whole family). You can edit trips you were on; admins edit everything; anyone can add a trip.
  - People live in KV `trips:people` (name, email, role, scrypt password hash, invite token hash, avatar timestamp). Avatars are private blobs at `trips/people/{id}.jpg`.
  - The shared `TRIPS_PASSWORD` only signs in (as "family") until the first person sets up an account.
  - `TRIPS_ADMIN_KEY` in the `x-trips-admin-key` header also acts as an admin for any action (used to import itineraries).
  - **Inviting someone** (also resets a forgotten password): `TRIPS_ADMIN_KEY=… node scripts/trips-invite.mjs email "Name" [--admin]` prints a one-time link (7 days) to `/welcome`. `TRIPS_ADMIN_KEY` is in Vercel env. There is deliberately no invite button in the UI.
- **Storage:**
  - KV `trips:list` holds the itineraries.
  - KV `trips:route:{id}` holds cached road geometry from OSRM.
  - KV `trips:photos:{id}` is a hash of photo metadata.
  - Photos are in a **private** Vercel Blob store (`trips-photos`) and are only served through `?action=photo` to signed-in browsers.
- **Privacy:** this repo is public. Never commit itinerary data or photos. The first itinerary was loaded from the `TRIPS_SEED` env var, which is only read when `trips:list` is empty.
- **Map tiles:** OpenFreeMap (free, no key). The custom editorial style is `Atlas.mapStyle()` in `trips/atlas.js`.
