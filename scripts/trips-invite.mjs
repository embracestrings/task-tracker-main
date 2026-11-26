#!/usr/bin/env node
// Invite someone to the Rey Family Travel Map (or send a fresh link to reset a password).
//
//   TRIPS_ADMIN_KEY=… node scripts/trips-invite.mjs person@example.com "Name" [--admin] [--host trips.embracestrings.com]
//
// Prints a one-time link (valid 7 days) that lets them choose their password.
// TRIPS_ADMIN_KEY is set in the Vercel project's environment variables.
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const admin = args.includes("--admin");
if (admin) args.splice(args.indexOf("--admin"), 1);
const host = flag("--host") || "trips.embracestrings.com";
const [email, name] = args;
if (!email || !process.env.TRIPS_ADMIN_KEY) {
  console.error('Usage: TRIPS_ADMIN_KEY=… node scripts/trips-invite.mjs email "Name" [--admin] [--host host]');
  process.exit(1);
}
const r = await fetch(`https://${host}/api/trips?action=invite`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-trips-admin-key": process.env.TRIPS_ADMIN_KEY },
  body: JSON.stringify({ email, name, admin, host }),
});
const j = await r.json().catch(() => ({}));
if (!r.ok) { console.error(j.error || `Failed (${r.status})`); process.exit(1); }
console.log(`${j.person.name} <${j.person.email}>`);
console.log(j.link);
