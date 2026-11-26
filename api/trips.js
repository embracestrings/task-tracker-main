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

// Sessions are "<subject>.<expiry>.<signature>": subject is a person id, or "family" for the
// shared password, which only works until the first person has set up their own account.
// Older two-part cookies ("<expiry>.<signature>") count as "family" sessions.
function readSession(req) {
  if (!process.env.TRIPS_PASSWORD) return null;
  const c = readCookie(req, COOKIE);
  if (!c) return null;
  const parts = c.split(".");
  const [sub, exp, sig] = parts.length === 2 ? ["family", parts[0], parts[1]] : parts;
  if (!sub || !exp || !sig || Number(exp) < Date.now()) return null;
  const signed = parts.length === 2 ? exp : `${sub}.${exp}`;
  return safeEqual(sig, sign(signed)) ? sub : null;
}

function setSession(res, req, sub) {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  const secure = (req.headers["x-forwarded-proto"] || "https") === "https" ? "; Secure" : "";
  const value = `${sub}.${exp}.${sign(`${sub}.${exp}`)}`;
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

// ─── People ──────────────────────────────────────────────────────────────────
// KV trips:people → [{ id, name, email, role, color, pw: {salt, hash}, invite: {hash, expires}, avatarAt }]

const PEOPLE_KEY = "trips:people";
const PERSON_COLORS = ["#1F3A5F", "#B5654A", "#5E7D6B", "#8C6F45", "#6B4E71", "#2F7A7A", "#9A4E5A", "#4F6A8F"];
const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || uid(6);

function hashPassword(pw, salt = crypto.randomBytes(16).toString("base64")) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString("base64") };
}
function checkPassword(pw, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const h = crypto.scryptSync(String(pw), rec.salt, 64);
  const want = Buffer.from(rec.hash, "base64");
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

// Profiles are created from the names already on trips the first time they are needed.
async function getPeople() {
  let people = parseMaybe(await kv.get(PEOPLE_KEY));
  if (Array.isArray(people)) return people;
  const trips = parseMaybe(await kv.get(LIST_KEY)) || [];
  const names = [];
  for (const t of trips) for (const n of [...(t.people || []), ...(t.groups || []).flatMap((g) => g.people || [])]) if (n && !names.includes(n)) names.push(n);
  people = names.map((name, i) => ({ id: slug(name), name, email: "", role: name === "Turner" ? "admin" : "member", color: PERSON_COLORS[i % PERSON_COLORS.length] }));
  await kv.set(PEOPLE_KEY, people);
  return people;
}
const savePeople = (people) => kv.set(PEOPLE_KEY, people);
const publicPerson = (p) => ({
  id: p.id, name: p.name, color: p.color, admin: p.role === "admin", active: !!(p.pw && p.pw.hash),
  avatarAt: p.avatarAt || null, email: p.email || "",
});
const bootstrapMode = (people) => !people.some((p) => p.pw && p.pw.hash);

// Who is asking: a person, or the shared "family" sign-in during setup.
async function whoIs(req) {
  // TRIPS_ADMIN_KEY (already able to mint invite links) also acts as an admin for scripted
  // edits such as importing an itinerary.
  const key = req.headers["x-trips-admin-key"];
  if (key && process.env.TRIPS_ADMIN_KEY && safeEqual(key, process.env.TRIPS_ADMIN_KEY)) {
    return { id: "admin-key", name: "Admin", admin: true, family: true, people: await getPeople() };
  }
  const sub = readSession(req);
  if (!sub) return null;
  const people = await getPeople();
  if (sub === "family") return bootstrapMode(people) ? { id: "family", name: "Family", admin: true, family: true, people } : null;
  const me = people.find((p) => p.id === sub && p.pw && p.pw.hash);
  return me ? { ...publicPerson(me), people } : null;
}

const canEditTrip = (me, trip) => !!me && (me.admin || !trip || (trip.travelers || []).includes(me.id));

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

const KINDS = ["home", "stay", "visit", "food", "activity", "airport"];
const TRAVEL = ["drive", "fly", "boat", "skip", "start"];

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
    travelers: (Array.isArray(t.travelers) ? t.travelers : []).filter(isId).slice(0, 40),
    family: !!t.family,
    states: (Array.isArray(t.states) ? t.states : []).map((s) => str(s, 4).toUpperCase()).slice(0, 60),
    countries: (Array.isArray(t.countries) ? t.countries : []).map((c) => str(c, 60)).filter(Boolean).slice(0, 60),
    groups,
    origin: t.origin
      ? { name: str(t.origin.name, 120), area: str(t.origin.area, 120), lat: num(t.origin.lat), lng: num(t.origin.lng) }
      : null,
    coverPhotoId: isId(t.coverPhotoId) ? t.coverPhotoId : null,
    regionsAt: null,
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
      kind: KINDS.includes(s.kind) ? s.kind : "visit",
      time: str(s.time, 60),
      note: str(s.note, 2000),
      group: groupIds.has(s.group) ? s.group : null,
      // How this stop was reached: drive (road route), fly (dashed arc), skip (side trip by
      // boat or on foot: pinned but not part of the line), start (position jumps here, no line).
      travel: TRAVEL.includes(s.travel) ? s.travel : s.route === false ? "skip" : "drive",
    })),
    updatedAt: Date.now(),
  };
}

// ─── Road routes ─────────────────────────────────────────────────────────────

const hasXY = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
const sameXY = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;

// For every day and every travel group, the legs that group travelled: road legs through
// consecutive driven stops, and single flight legs. Groups that travelled the same leg share
// one segment (groups: null means everyone).
export function routePlan(trip) {
  const groupIds = trip.groups && trip.groups.length ? trip.groups.map((g) => g.id) : ["_all"];
  const start = hasXY(trip.origin) ? [trip.origin.lng, trip.origin.lat] : null;
  const last = Object.fromEntries(groupIds.map((g) => [g, start]));
  const plan = [];
  const days = [...trip.days].sort((a, b) => a.n - b.n);
  const dayNums = days.length ? days.map((d) => d.n) : [...new Set(trip.stops.map((s) => s.day))].sort((a, b) => a - b);
  const travelOf = (s) => s.travel || (s.route === false ? "skip" : "drive");
  for (const n of dayNums) {
    const byPath = new Map();
    for (const g of groupIds) {
      const legs = [];
      let drive = last[g] ? [last[g]] : [];
      const closeDrive = () => { if (drive.length >= 2) legs.push({ mode: "drive", wps: drive }); };
      for (const s of trip.stops) {
        if (s.day !== n || !hasXY(s)) continue;
        if (s.group && s.group !== g) continue;
        const how = travelOf(s);
        if (how === "skip") continue;
        const p = [s.lng, s.lat];
        const pos = drive[drive.length - 1];
        if (how === "start") { closeDrive(); drive = [p]; continue; }
        if (how === "fly" || how === "boat") {
          closeDrive();
          if (pos && !sameXY(pos, p)) legs.push({ mode: how, wps: [pos, p] });
          drive = [p];
          continue;
        }
        if (!sameXY(pos, p)) drive.push(p);
      }
      closeDrive();
      if (drive.length) last[g] = drive[drive.length - 1];
      for (const leg of legs) {
        const k = leg.mode + JSON.stringify(leg.wps);
        if (!byPath.has(k)) byPath.set(k, { ...leg, groups: [] });
        byPath.get(k).groups.push(g);
      }
    }
    for (const { mode, wps, groups } of byPath.values()) {
      const everyone = groups.length === groupIds.length || groupIds[0] === "_all";
      // drive keys match the earlier format so cached road geometry stays valid
      const keySrc = (mode === "drive" ? "" : mode) + JSON.stringify(wps);
      plan.push({
        key: crypto.createHash("sha1").update(keySrc).digest("hex").slice(0, 16),
        day: n,
        mode,
        groups: everyone ? null : groups,
        wps,
      });
    }
  }
  return plan;
}

// Great-circle arc between two [lng,lat] points, for flights.
function arc(a, b, steps = 64) {
  const toR = Math.PI / 180;
  const [l1, p1] = [a[0] * toR, a[1] * toR];
  const [l2, p2] = [b[0] * toR, b[1] * toR];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!d) return [a, b];
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([+(Math.atan2(y, x) / toR).toFixed(4), +(Math.atan2(z, Math.sqrt(x * x + y * y)) / toR).toFixed(4)]);
  }
  return { coords: out, distance: Math.round(d * 6371000) };
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
const LEGS_KEY = "trips:legs"; // hash: leg key → traced road, shared by previews and saves

async function buildRoute(trip, budgetMs = 20000, { persist = true } = {}) {
  const started = Date.now();
  const prev = parseMaybe(await kv.get(routeKey(trip.id))) || { segments: [] };
  const cache = new Map(prev.segments.filter((s) => !s.straight && (s.mode || "drive") === "drive").map((s) => [s.key, s]));
  const plan = routePlan(trip);
  const missing = plan.filter((p) => p.mode === "drive" && !cache.has(p.key)).map((p) => p.key);
  if (missing.length) {
    try {
      const got = await kv.hmget(LEGS_KEY, ...missing);
      (Array.isArray(got) ? got : missing.map((k) => got && got[k])).forEach((v, i) => { const seg = parseMaybe(v); if (seg && seg.coords) cache.set(missing[i], seg); });
    } catch {}
  }
  const fresh = {};
  const segments = [];
  let incomplete = false;
  for (const p of plan) {
    if (p.mode === "fly" || p.mode === "boat") {
      const f = arc(p.wps[0], p.wps[1], p.mode === "boat" ? 12 : 64);
      segments.push({ key: p.key, day: p.day, mode: p.mode, groups: p.groups, coords: f.coords, distance: f.distance, duration: null });
      continue;
    }
    let hit = cache.get(p.key);
    if (!hit && Date.now() - started < budgetMs) {
      const r = await osrm(p.wps);
      if (r) { hit = { key: p.key, ...r }; fresh[p.key] = hit; }
    }
    if (!hit) incomplete = true;
    segments.push(
      hit
        ? { key: p.key, day: p.day, mode: "drive", groups: p.groups, coords: hit.coords, distance: hit.distance, duration: hit.duration }
        : { key: p.key, day: p.day, mode: "drive", groups: p.groups, coords: p.wps, distance: null, duration: null, straight: true }
    );
  }
  const route = { segments, incomplete, builtAt: Date.now() };
  if (Object.keys(fresh).length) { try { await kv.hset(LEGS_KEY, fresh); } catch {} }
  if (persist) await kv.set(routeKey(trip.id), route);
  return route;
}

async function routeFor(trip, budgetMs) {
  const r = parseMaybe(await kv.get(routeKey(trip.id)));
  const keys = routePlan(trip).map((p) => p.key).join(",");
  const fresh = r && r.segments && r.segments.map((s) => s.key).join(",") === keys && !r.incomplete && r.segments.every((s) => s.mode);
  return fresh ? r : buildRoute(trip, budgetMs);
}

async function personForToken(token, people) {
  if (!token) return null;
  people = people || (await getPeople());
  const h = crypto.createHash("sha256").update(token).digest("hex");
  return people.find((p) => p.invite && p.invite.expires > Date.now() && safeEqual(p.invite.hash, h)) || null;
}

// Trips saved before profiles existed list names; give them traveler ids once.
async function linkTravelers(trips, people) {
  let changed = false;
  for (const t of trips) {
    if (Array.isArray(t.travelers) && t.travelers.length) continue;
    const ids = (t.people || []).map((n) => (people.find((p) => p.name.toLowerCase() === String(n).toLowerCase()) || {}).id).filter(Boolean);
    if (ids.length) { t.travelers = ids; changed = true; }
  }
  if (changed) await kv.set(LIST_KEY, trips);
}

// ─── States and countries ────────────────────────────────────────────────────
// Worked out from the stops plus points sampled along the driven roads, reverse-geocoded on
// a coarse grid that is cached forever in KV (one lookup per ~25 km cell, ever).
const US_STATES = { Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY" };
const COUNTRY_NAMES = { US: "United States", DE: "Germany", CH: "Switzerland", FR: "France", IT: "Italy", AT: "Austria", CZ: "Czechia", GB: "United Kingdom", ES: "Spain", MX: "Mexico", CA: "Canada", BS: "Bahamas", NL: "Netherlands", BE: "Belgium" };

async function placeAt(lat, lng) {
  const cell = `${(Math.round(lat * 4) / 4).toFixed(2)},${(Math.round(lng * 4) / 4).toFixed(2)}`;
  const key = `trips:geo:${cell}`;
  const hit = parseMaybe(await kv.get(key));
  if (hit) return hit;
  let out = null;
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=en&limit=1`, { headers: { "User-Agent": "family-trips-atlas/1.0" }, signal: AbortSignal.timeout(3500) });
    if (r.ok) {
      const f = ((await r.json()).features || [])[0];
      if (f) out = { cc: (f.properties.countrycode || "").toUpperCase(), country: f.properties.country || "", state: f.properties.state || "" };
      else out = { cc: "", country: "", state: "" }; // open water
    }
  } catch {}
  if (!out) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=5&accept-language=en&lat=${lat}&lon=${lng}`, { headers: { "User-Agent": "family-trips-atlas/1.0" }, signal: AbortSignal.timeout(3500) });
      if (r.ok) { const j = await r.json(); const a = j.address || {}; out = { cc: (a.country_code || "").toUpperCase(), country: a.country || "", state: a.state || "" }; }
    } catch {}
  }
  if (out) await kv.set(key, out);
  return out;
}

// Lookups only ever add: a short drive through a country can fall between samples, so what
// is already listed stays.
function mergeRegions(trip, reg) {
  trip.states = [...new Set([...(trip.states || []), ...reg.states])].sort();
  trip.countries = [...new Set([...(trip.countries || []), ...reg.countries])];
}

async function deriveRegions(trip, route, budgetMs = 9000) {
  const started = Date.now();
  const pts = [];
  // airports are layovers, not places visited
  for (const st of trip.stops) if (hasXY(st) && st.kind !== "airport") pts.push([st.lat, st.lng]);
  for (const seg of route.segments || []) {
    if ((seg.mode || "drive") !== "drive") continue;
    let acc = 0;
    for (let i = 1; i < seg.coords.length; i++) {
      const [x0, y0] = seg.coords[i - 1], [x1, y1] = seg.coords[i];
      acc += Math.hypot(x1 - x0, (y1 - y0) * 1.2);
      if (acc > 0.3) { pts.push([y1, x1]); acc = 0; }
    }
  }
  const seen = new Set(), cells = [];
  for (const [lat, lng] of pts) {
    const c = `${Math.round(lat * 4)},${Math.round(lng * 4)}`;
    if (!seen.has(c)) { seen.add(c); cells.push([lat, lng]); }
  }
  const states = new Set(), countries = new Set();
  let complete = true;
  for (let i = 0; i < cells.length; i += 6) {
    const left = budgetMs - (Date.now() - started);
    if (left < 500) { complete = false; break; }
    const batch = Promise.all(cells.slice(i, i + 6).map(([a, b]) => placeAt(a, b)));
    const res = await Promise.race([batch, new Promise((ok) => setTimeout(() => ok(null), left))]);
    if (!res) { complete = false; break; }
    for (const r of res) {
      if (!r) { complete = false; continue; }
      if (r.cc) countries.add(COUNTRY_NAMES[r.cc] || r.country);
      if (r.cc === "US" && US_STATES[r.state]) states.add(US_STATES[r.state]);
    }
  }
  return { states: [...states].sort(), countries: [...countries], complete };
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
      const email = str(req.body?.email, 200).trim().toLowerCase();
      const pw = str(req.body?.password, 200);
      const people = await getPeople();
      if (!email) {
        // the shared family password only opens the map until someone sets up an account
        if (bootstrapMode(people) && safeEqual(pw.trim(), process.env.TRIPS_PASSWORD)) {
          setSession(res, req, "family");
          return res.status(200).json({ ok: true });
        }
        return res.status(401).json({ error: "Enter your email and password." });
      }
      const p = people.find((x) => x.email && x.email.toLowerCase() === email);
      if (!p || !checkPassword(pw, p.pw)) return res.status(401).json({ error: "That email and password don't match." });
      setSession(res, req, p.id);
      return res.status(200).json({ ok: true });
    }

    // Invite links: one-time, expire after 7 days. No sign-in needed to read or accept one.
    if (action === "inviteInfo") {
      const p = await personForToken(str(req.query.token, 200));
      if (!p) return res.status(404).json({ error: "This link has expired or was already used." });
      return res.status(200).json({ name: p.name, email: p.email });
    }
    if (action === "acceptInvite" && req.method === "POST") {
      const token = str(req.body?.token, 200);
      const password = str(req.body?.password, 200);
      if (password.length < 8) return res.status(400).json({ error: "Use at least 8 characters." });
      const people = await getPeople();
      const p = await personForToken(token, people);
      if (!p) return res.status(404).json({ error: "This link has expired or was already used." });
      p.pw = hashPassword(password);
      delete p.invite;
      if (req.body?.name) p.name = str(req.body.name, 60).trim() || p.name;
      await savePeople(people);
      setSession(res, req, p.id);
      return res.status(200).json({ ok: true });
    }

    // Creating invites: an admin who is signed in, or anyone holding TRIPS_ADMIN_KEY
    // (used by scripts/trips-invite.mjs).
    if (action === "invite" && req.method === "POST") {
      const key = req.headers["x-trips-admin-key"];
      const byKey = !!(process.env.TRIPS_ADMIN_KEY && key && safeEqual(key, process.env.TRIPS_ADMIN_KEY));
      const me = byKey ? null : await whoIs(req);
      if (!byKey && !(me && me.admin)) return res.status(403).json({ error: "Only an admin can invite people." });
      const email = str(req.body?.email, 200).trim().toLowerCase();
      const name = str(req.body?.name, 60).trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "That email doesn't look right." });
      const people = await getPeople();
      let p = people.find((x) => (x.email || "").toLowerCase() === email) ||
        (req.body?.personId && people.find((x) => x.id === req.body.personId)) ||
        (name && people.find((x) => !x.email && x.name.toLowerCase() === name.toLowerCase()));
      if (!p) {
        let id = slug(name || email.split("@")[0]);
        while (people.some((x) => x.id === id)) id = `${id}-${uid(3)}`.toLowerCase();
        p = { id, name: name || email.split("@")[0], role: "member", color: PERSON_COLORS[people.length % PERSON_COLORS.length] };
        people.push(p);
      }
      if (people.some((x) => x !== p && (x.email || "").toLowerCase() === email)) return res.status(409).json({ error: "Someone else already uses that email." });
      p.email = email;
      if (name) p.name = name;
      if (req.body?.admin === true) p.role = "admin";
      const token = crypto.randomBytes(24).toString("base64url");
      p.invite = { hash: crypto.createHash("sha256").update(token).digest("hex"), expires: Date.now() + 7 * 864e5 };
      await savePeople(people);
      const host = str(req.body?.host, 200) || req.headers["x-forwarded-host"] || req.headers.host;
      return res.status(200).json({ person: publicPerson(p), link: `https://${host}/trips/welcome?token=${token}`, expires: p.invite.expires });
    }

    if (action === "logout") {
      clearSession(res);
      return res.status(200).json({ ok: true });
    }

    const me = await whoIs(req);
    if (!me) return res.status(401).json({ error: "Sign in" });
    res.setHeader("Cache-Control", "private, no-store");
    const { people, ...meOut } = me;

    if (action === "session") return res.status(200).json({ ok: true, me: meOut });

    if (action === "data") {
      const trips = await getTrips();
      await linkTravelers(trips, people);
      const out = await Promise.all(trips.map(async (t) => {
        const [route, photos] = await Promise.all([routeFor(t, 8000), getPhotos(t.id)]);
        return { ...t, route, photos, canEdit: canEditTrip(me, t) };
      }));
      return res.status(200).json({ trips: out, people: people.map(publicPerson), me: meOut, now: Date.now() });
    }

    // Fill in states/countries for trips saved before they were automatic. Called by the page
    // after it has loaded, so it never holds up the map. Hard 20 s deadline.
    if (action === "fillRegions") {
      const trips = await getTrips();
      const deadline = Date.now() + 20000;
      let changed = 0;
      for (const t of trips) {
        if (t.regionsAt || Date.now() > deadline - 3000) continue;
        const route = parseMaybe(await kv.get(routeKey(t.id))) || { segments: [] };
        const reg = await deriveRegions(t, route, Math.min(8000, deadline - Date.now() - 2000));
        mergeRegions(t, reg);
        if (reg.complete) t.regionsAt = Date.now();
        changed++;
      }
      if (changed) await kv.set(LIST_KEY, trips);
      return res.status(200).json({ changed, pending: trips.filter((t) => !t.regionsAt).length });
    }

    if (action === "avatar") {
      res.removeHeader("Cache-Control");
      const id = req.query.id;
      if (!isId(id)) return res.status(400).end();
      const r = await get(`trips/people/${id}.jpg`, { access: "private" });
      if (!r || r.statusCode !== 200) return res.status(404).end();
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.setHeader("Content-Type", "image/jpeg");
      res.status(200);
      Readable.fromWeb(r.stream).pipe(res);
      return;
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
      const lat = num(req.query.lat);
      const lng = num(req.query.lng);
      let results = null;
      // Photon first (fast, typo-tolerant); OpenStreetMap's Nominatim if Photon is down or busy.
      try {
        const bias = lat != null && lng != null ? `&lat=${lat}&lon=${lng}` : "";
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en${bias}`, {
          headers: { "User-Agent": "family-trips-atlas/1.0" },
          signal: AbortSignal.timeout(6000),
        });
        if (r.ok) {
          const j = await r.json();
          results = (j.features || []).map((f) => {
            const p = f.properties || {};
            const area = [p.city || p.town || p.village || p.county, p.state, p.countrycode === "US" ? "" : p.country]
              .filter(Boolean)
              .join(", ");
            return { name: p.name || p.street || q, area, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
          });
        }
      } catch {}
      if (!results || !results.length) {
        try {
          const r = await fetch(
            `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&accept-language=en&q=${encodeURIComponent(q)}`,
            { headers: { "User-Agent": "family-trips-atlas/1.0" }, signal: AbortSignal.timeout(8000) }
          );
          if (r.ok) {
            const j = await r.json();
            results = j.map((x) => {
              const a = x.address || {};
              const area = [a.city || a.town || a.village || a.county, a.state, a.country_code === "us" ? "" : a.country]
                .filter(Boolean)
                .join(", ");
              return { name: x.name || x.display_name.split(",")[0], area, lat: Number(x.lat), lng: Number(x.lon) };
            });
          }
        } catch {}
      }
      return res.status(200).json({ results: results || [] });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    const body = req.body || {};

    if (action === "updateProfile") {
      if (me.family) return res.status(400).json({ error: "Set up your own account first." });
      const all = await getPeople();
      const p = all.find((x) => x.id === me.id);
      if (body.name != null) p.name = str(body.name, 60).trim() || p.name;
      if (body.newPassword != null) {
        if (!checkPassword(str(body.currentPassword, 200), p.pw)) return res.status(401).json({ error: "Your current password isn't right." });
        if (str(body.newPassword, 200).length < 8) return res.status(400).json({ error: "Use at least 8 characters." });
        p.pw = hashPassword(str(body.newPassword, 200));
      }
      if (typeof body.avatar === "string") {
        const buf = Buffer.from(body.avatar, "base64");
        if (!(buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8)) return res.status(400).json({ error: "Images must be JPEG" });
        await put(`trips/people/${p.id}.jpg`, buf, { access: "private", contentType: "image/jpeg", addRandomSuffix: false, allowOverwrite: true });
        p.avatarAt = Date.now();
      }
      await savePeople(all);
      return res.status(200).json({ me: publicPerson(p) });
    }

    // Writes to an existing trip need you to have been on it (admins can edit anything).
    const tripForWrite = async (id) => (await getTrips()).find((t) => t.id === id);
    if (["deleteTrip", "upload", "updatePhotos", "deletePhotos"].includes(action)) {
      const t = await tripForWrite(action === "deleteTrip" ? body.id : body.tripId);
      if (t && !canEditTrip(me, t)) return res.status(403).json({ error: "Only the people on this trip can change it." });
    }

    // Trace roads for an itinerary that is still being edited, without saving anything.
    if (action === "previewRoute") {
      const trip = cleanTrip(body.trip || {});
      return res.status(200).json({ route: await buildRoute(trip, 15000, { persist: false }) });
    }

    if (action === "saveTrip") {
      const trip = cleanTrip(body.trip || {});
      const trips = await getTrips();
      const before = trips.find((t) => t.id === trip.id);
      if (before && !canEditTrip(me, before)) return res.status(403).json({ error: "Only the people on this trip can change it." });
      // whoever creates a trip is on it
      if (!before && !me.family && !trip.travelers.includes(me.id)) trip.travelers.push(me.id);
      const i = trips.findIndex((t) => t.id === trip.id);
      if (i >= 0) trips[i] = trip;
      else trips.push(trip);
      await kv.set(LIST_KEY, trips);
      const route = await buildRoute(trip, 17000);
      const reg = await deriveRegions(trip, route, 6000);
      mergeRegions(trip, reg);
      if (reg.complete) trip.regionsAt = Date.now();
      await kv.set(LIST_KEY, trips);
      return res.status(200).json({ trip: { ...trip, route, photos: await getPhotos(trip.id), canEdit: canEditTrip(me, trip) } });
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
