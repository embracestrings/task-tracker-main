// api/trips.js — backend for the family trips atlas (trips.embracestrings.com)
//
// One function, many actions (keeps us well under the Hobby function limit):
//   GET  ?action=session            → 200 if the trips cookie is valid, else 401
//   POST ?action=login   {password} → sets the trips cookie
//   POST ?action=logout             → clears it
//   GET  ?action=data               → every trip, its road routes, and its photo metadata
//   POST ?action=saveTrip {trip}    → create/update a trip, recompute changed road legs
//   POST ?action=deleteTrip {id}    → remove a trip, its route and every photo
//   POST ?action=upload  {tripId, photo, full, thumb}  (base64 JPEGs, resized in the browser)
//   POST ?action=updatePhotos {tripId, photos:[{id, ...fields}]}
//   POST ?action=deletePhotos {tripId, ids:[...]}
//   GET  ?action=photo&trip=…&id=…&v=f|t   → streams a private blob to a signed-in browser
//   GET  ?action=geocode&q=…        → place search for the admin page
//
// Storage
//   KV   trips:list              → [trip, …]   (itinerary only, no geometry)
//   KV   trips:route:{tripId}    → { segments: [{ key, day, groups, coords, distance, duration }] }
//   KV   trips:photos:{tripId}   → hash photoId → photo metadata
//   Blob trips/{tripId}/{photoId}-f.jpg and -t.jpg   (private store)
//
// Env: TRIPS_PASSWORD (required), TRIPS_SECRET (optional cookie key), TRIPS_SEED (optional
// JSON itinerary loaded the first time the list is empty, so the itinerary never has to be
// committed to this public repo), BLOB_READ_WRITE_TOKEN + KV_* (set by the integrations).

import { kv } from "@vercel/kv";
import { put, get, del, list } from "@vercel/blob";
import crypto from "node:crypto";
import { Readable } from "node:stream";

const LIST_KEY = "trips:list";
const routeKey = (id) => `trips:route:${id}`;
const photosKey = (id) => `trips:photos:${id}`;
const COOKIE = "trips_session";
const SESSION_DAYS = 400; // browsers cap cookie lifetime at 400 days
const OSRM = "https://router.project-osrm.org/route/v1/driving/";

// ─── Auth ────────────────────────────────────────────────────────────────────

function secret() {
  return process.env.TRIPS_SECRET || `trips-cookie:${process.env.TRIPS_PASSWORD || ""}`;
}

function sign(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

function isAuthed(req) {
  if (!process.env.TRIPS_PASSWORD) return false;
  const c = readCookie(req, COOKIE);
  if (!c) return false;
  const [exp, sig] = c.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}

function setSession(res, req) {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  const secure = (req.headers["x-forwarded-proto"] || "https") === "https" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
}

function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function tooManyAttempts(req) {
  const ip = String(req.headers["x-forwarded-for"] || "local").split(",")[0].trim();
  const key = `trips:rl:${ip}`;
  try {
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, 900);
    return n > 12;
  } catch {
    return false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const uid = (n = 10) => crypto.randomBytes(n).toString("base64url").replace(/[-_]/g, "").slice(0, n);
const isId = (s) => typeof s === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(s);
const str = (v, max = 2000) => (typeof v === "string" ? v.slice(0, max) : v == null ? "" : String(v).slice(0, max));
const num = (v) => (v === null || v === "" || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

function parseMaybe(v) {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

async function getTrips() {
  let trips = parseMaybe(await kv.get(LIST_KEY));
  if (!Array.isArray(trips)) {
    trips = [];
    if (process.env.TRIPS_SEED) {
      try {
        const seed = JSON.parse(process.env.TRIPS_SEED);
        trips = (Array.isArray(seed) ? seed : [seed]).map(cleanTrip);
      } catch (e) {
        console.error("TRIPS_SEED is not valid JSON:", e.message);
      }
    }
    await kv.set(LIST_KEY, trips);
  }
  return trips;
}

// Whitelist every field so the admin page can never write arbitrary blobs of data.
function cleanTrip(t) {
  const id = isId(t.id) ? t.id : uid();
  const groups = (Array.isArray(t.groups) ? t.groups : []).slice(0, 6).map((g) => ({
    id: isId(g.id) ? g.id : uid(6),
    name: str(g.name, 120),
    people: (Array.isArray(g.people) ? g.people : []).map((p) => str(p, 60)).slice(0, 20),
    color: /^#[0-9a-fA-F]{6}$/.test(g.color) ? g.color : "#B99A6C",
  }));
  const groupIds = new Set(groups.map((g) => g.id));
  return {
    id,
    title: str(t.title, 160) || "Untitled trip",
    subtitle: str(t.subtitle, 240),
    startDate: str(t.startDate, 10),
    endDate: str(t.endDate, 10),
    color: /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : "#1F3A5F",
    people: (Array.isArray(t.people) ? t.people : []).map((p) => str(p, 60)).slice(0, 30),
    states: (Array.isArray(t.states) ? t.states : []).map((s) => str(s, 4).toUpperCase()).slice(0, 60),
    groups,
    origin: t.origin
      ? { name: str(t.origin.name, 120), area: str(t.origin.area, 120), lat: num(t.origin.lat), lng: num(t.origin.lng) }
      : null,
    coverPhotoId: isId(t.coverPhotoId) ? t.coverPhotoId : null,
    hidden: !!t.hidden,
    days: (Array.isArray(t.days) ? t.days : []).slice(0, 120).map((d, i) => ({
      n: Number.isInteger(d.n) ? d.n : i + 1,
      date: str(d.date, 10),
      dateEnd: str(d.dateEnd, 10),
      title: str(d.title, 160),
      summary: str(d.summary, 2000),
    })),
    stops: (Array.isArray(t.stops) ? t.stops : []).slice(0, 400).map((s) => ({
      id: isId(s.id) ? s.id : uid(),
      day: Number(s.day) || 1,
      name: str(s.name, 160),
      area: str(s.area, 160),
      lat: num(s.lat),
      lng: num(s.lng),
      kind: ["home", "stay", "visit", "food", "activity"].includes(s.kind) ? s.kind : "visit",
      time: str(s.time, 60),
      note: str(s.note, 2000),
      group: groupIds.has(s.group) ? s.group : null,
      route: s.route !== false,
    })),
    updatedAt: Date.now(),
  };
}

// ─── Road routes ─────────────────────────────────────────────────────────────

const hasXY = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
const sameXY = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;

// For every day and every travel group, the ordered waypoints that group drove through.
// Groups that drove the same waypoints share one segment (groups: null means everyone).
export function routePlan(trip) {
  const groupIds = trip.groups && trip.groups.length ? trip.groups.map((g) => g.id) : ["_all"];
  const start = hasXY(trip.origin) ? [trip.origin.lng, trip.origin.lat] : null;
  const last = Object.fromEntries(groupIds.map((g) => [g, start]));
  const plan = [];
  const days = [...trip.days].sort((a, b) => a.n - b.n);
  const dayNums = days.length ? days.map((d) => d.n) : [...new Set(trip.stops.map((s) => s.day))].sort((a, b) => a - b);
  for (const n of dayNums) {
    const byPath = new Map();
    for (const g of groupIds) {
      const wps = last[g] ? [last[g]] : [];
      for (const s of trip.stops) {
        if (s.day !== n || !hasXY(s) || s.route === false) continue;
        if (s.group && s.group !== g) continue;
        const p = [s.lng, s.lat];
        if (!sameXY(wps[wps.length - 1], p)) wps.push(p);
      }
      if (wps.length) last[g] = wps[wps.length - 1];
      if (wps.length < 2) continue;
      const k = JSON.stringify(wps);
      if (!byPath.has(k)) byPath.set(k, { wps, groups: [] });
      byPath.get(k).groups.push(g);
    }
    for (const { wps, groups } of byPath.values()) {
      const everyone = groups.length === groupIds.length || groupIds[0] === "_all";
      plan.push({
        key: crypto.createHash("sha1").update(JSON.stringify(wps)).digest("hex").slice(0, 16),
        day: n,
        groups: everyone ? null : groups,
        wps,
      });
    }
  }
  return plan;
}

// Douglas–Peucker on [lng,lat] pairs; tolerance in degrees.
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy || 1e-12;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let u = ((px - ax) * dx + (py - ay) * dy) / len;
      u = Math.max(0, Math.min(1, u));
      const ex = ax + u * dx - px;
      const ey = ay + u * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > t2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

async function osrm(wps) {
  const url = `${OSRM}${wps.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(";")}?overview=full&geometries=geojson`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "family-trips-atlas/1.0" }, signal: AbortSignal.timeout(9000) });
      if (r.status === 429) {
        await new Promise((ok) => setTimeout(ok, 1200));
        continue;
      }
      const j = await r.json();
      if (j.code !== "Ok" || !j.routes?.[0]) return null;
      const rt = j.routes[0];
      const coords = simplify(rt.geometry.coordinates, 0.0004).map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
      return { coords, distance: Math.round(rt.distance), duration: Math.round(rt.duration) };
    } catch {
      await new Promise((ok) => setTimeout(ok, 600));
    }
  }
  return null;
}

// Recomputes only the legs whose waypoints changed. Legs the router can't solve fall back
// to straight lines (flagged), so a flaky router never blocks the page.
async function buildRoute(trip, budgetMs = 20000) {
  const started = Date.now();
  const prev = parseMaybe(await kv.get(routeKey(trip.id))) || { segments: [] };
  const cache = new Map(prev.segments.filter((s) => !s.straight).map((s) => [s.key, s]));
  const segments = [];
  let incomplete = false;
  for (const p of routePlan(trip)) {
    let hit = cache.get(p.key);
    if (!hit && Date.now() - started < budgetMs) {
      const r = await osrm(p.wps);
      if (r) hit = { key: p.key, ...r };
    }
    if (!hit) incomplete = true;
    segments.push(
      hit
        ? { key: p.key, day: p.day, groups: p.groups, coords: hit.coords, distance: hit.distance, duration: hit.duration }
        : { key: p.key, day: p.day, groups: p.groups, coords: p.wps, distance: null, duration: null, straight: true }
    );
  }
  const route = { segments, incomplete, builtAt: Date.now() };
  await kv.set(routeKey(trip.id), route);
  return route;
}

async function routeFor(trip, budgetMs) {
  const r = parseMaybe(await kv.get(routeKey(trip.id)));
  const keys = routePlan(trip).map((p) => p.key).join(",");
  const fresh = r && r.segments && r.segments.map((s) => s.key).join(",") === keys && !r.incomplete;
  return fresh ? r : buildRoute(trip, budgetMs);
}

// ─── Photos ──────────────────────────────────────────────────────────────────

function cleanPhotoFields(p) {
  const out = {};
  if ("caption" in p) out.caption = str(p.caption, 1000);
  if ("title" in p) out.title = str(p.title, 200);
  if ("stopId" in p) out.stopId = isId(p.stopId) ? p.stopId : null;
  if ("day" in p) out.day = num(p.day);
  if ("lat" in p) out.lat = num(p.lat);
  if ("lng" in p) out.lng = num(p.lng);
  if ("takenAt" in p) out.takenAt = str(p.takenAt, 40);
  if ("featured" in p) out.featured = !!p.featured;
  if ("hidden" in p) out.hidden = !!p.hidden;
  if ("placed" in p) out.placed = ["gps", "filename", "date", "manual", "none"].includes(p.placed) ? p.placed : "none";
  return out;
}

async function getPhotos(tripId) {
  const h = (await kv.hgetall(photosKey(tripId))) || {};
  return Object.values(h)
    .map(parseMaybe)
    .filter((p) => p && p.id)
    .sort((a, b) => String(a.takenAt || a.uploadedAt).localeCompare(String(b.takenAt || b.uploadedAt)));
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const action = req.query.action;
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  try {
    if (action === "login" && req.method === "POST") {
      if (!process.env.TRIPS_PASSWORD) return res.status(503).json({ error: "TRIPS_PASSWORD is not set in Vercel." });
      if (await tooManyAttempts(req)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes." });
      const pw = str(req.body?.password, 200);
      if (!safeEqual(pw.trim(), process.env.TRIPS_PASSWORD)) return res.status(401).json({ error: "That isn't it." });
      setSession(res, req);
      return res.status(200).json({ ok: true });
    }

    if (action === "logout") {
      clearSession(res);
      return res.status(200).json({ ok: true });
    }

    if (!isAuthed(req)) return res.status(401).json({ error: "Sign in" });
    res.setHeader("Cache-Control", "private, no-store");

    if (action === "session") return res.status(200).json({ ok: true });

    if (action === "data") {
      const trips = await getTrips();
      const out = [];
      for (const t of trips) {
        const [route, photos] = await Promise.all([routeFor(t, 8000), getPhotos(t.id)]);
        out.push({ ...t, route, photos });
      }
      return res.status(200).json({ trips: out, now: Date.now() });
    }

    if (action === "photo") {
      res.removeHeader("Cache-Control");
      const { trip, id, v } = req.query;
      if (!isId(trip) || !isId(id)) return res.status(400).end();
      const pathname = `trips/${trip}/${id}-${v === "f" ? "f" : "t"}.jpg`;
      const r = await get(pathname, { access: "private", ifNoneMatch: req.headers["if-none-match"] || undefined });
      if (!r) return res.status(404).end();
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      if (r.blob?.etag) res.setHeader("ETag", r.blob.etag);
      if (r.statusCode === 304) return res.status(304).end();
      res.setHeader("Content-Type", r.blob.contentType || "image/jpeg");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.status(200);
      Readable.fromWeb(r.stream).pipe(res);
      return;
    }

    if (action === "geocode") {
      const q = str(req.query.q, 200).trim();
      if (!q) return res.status(200).json({ results: [] });
      const bias = req.query.lat && req.query.lng ? `&lat=${num(req.query.lat)}&lon=${num(req.query.lng)}` : "";
      const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en${bias}`, {
        headers: { "User-Agent": "family-trips-atlas/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      const results = (j.features || []).map((f) => {
        const p = f.properties || {};
        const area = [p.city || p.town || p.village || p.county, p.state, p.countrycode === "US" ? "" : p.country]
          .filter(Boolean)
          .join(", ");
        return { name: p.name || p.street || q, area, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
      });
      return res.status(200).json({ results });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    const body = req.body || {};

    if (action === "saveTrip") {
      const trip = cleanTrip(body.trip || {});
      const trips = await getTrips();
      const i = trips.findIndex((t) => t.id === trip.id);
      if (i >= 0) trips[i] = trip;
      else trips.push(trip);
      await kv.set(LIST_KEY, trips);
      const route = await buildRoute(trip, 22000);
      return res.status(200).json({ trip: { ...trip, route, photos: await getPhotos(trip.id) } });
    }

    if (action === "deleteTrip") {
      if (!isId(body.id)) return res.status(400).json({ error: "Bad id" });
      const trips = (await getTrips()).filter((t) => t.id !== body.id);
      await kv.set(LIST_KEY, trips);
      let cursor;
      do {
        const page = await list({ prefix: `trips/${body.id}/`, cursor, limit: 1000 });
        if (page.blobs.length) await del(page.blobs.map((b) => b.url));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      await kv.del(routeKey(body.id), photosKey(body.id));
      return res.status(200).json({ ok: true });
    }

    if (action === "upload") {
      const { tripId, photo = {}, full, thumb } = body;
      if (!isId(tripId) || typeof full !== "string" || typeof thumb !== "string")
        return res.status(400).json({ error: "Missing image" });
      const trips = await getTrips();
      if (!trips.some((t) => t.id === tripId)) return res.status(404).json({ error: "No such trip" });
      const id = uid(12);
      const fullBuf = Buffer.from(full, "base64");
      const thumbBuf = Buffer.from(thumb, "base64");
      const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
      if (!isJpeg(fullBuf) || !isJpeg(thumbBuf)) return res.status(400).json({ error: "Images must be JPEG" });
      const opts = { access: "private", contentType: "image/jpeg", addRandomSuffix: false };
      const [f, t] = await Promise.all([
        put(`trips/${tripId}/${id}-f.jpg`, fullBuf, opts),
        put(`trips/${tripId}/${id}-t.jpg`, thumbBuf, opts),
      ]);
      const meta = {
        id,
        tripId,
        fileName: str(photo.fileName, 200),
        width: num(photo.width),
        height: num(photo.height),
        uploadedAt: new Date().toISOString(),
        urls: [f.url, t.url],
        caption: "",
        title: "",
        stopId: null,
        day: null,
        lat: null,
        lng: null,
        takenAt: "",
        featured: false,
        hidden: false,
        placed: "none",
        ...cleanPhotoFields(photo),
      };
      await kv.hset(photosKey(tripId), { [id]: meta });
      return res.status(200).json({ photo: meta });
    }

    if (action === "updatePhotos") {
      const { tripId, photos = [] } = body;
      if (!isId(tripId)) return res.status(400).json({ error: "Bad trip" });
      const existing = (await kv.hgetall(photosKey(tripId))) || {};
      const updates = {};
      for (const p of photos.slice(0, 500)) {
        const cur = parseMaybe(existing[p.id]);
        if (!cur) continue;
        updates[p.id] = { ...cur, ...cleanPhotoFields(p) };
      }
      if (Object.keys(updates).length) await kv.hset(photosKey(tripId), updates);
      return res.status(200).json({ photos: Object.values(updates) });
    }

    if (action === "deletePhotos") {
      const { tripId, ids = [] } = body;
      if (!isId(tripId)) return res.status(400).json({ error: "Bad trip" });
      const existing = (await kv.hgetall(photosKey(tripId))) || {};
      const gone = ids.filter(isId).filter((id) => existing[id]);
      const urls = gone.flatMap((id) => parseMaybe(existing[id]).urls || []);
      if (urls.length) await del(urls);
      if (gone.length) await kv.hdel(photosKey(tripId), ...gone);
      return res.status(200).json({ deleted: gone });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("trips api error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
