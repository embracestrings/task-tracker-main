// trips/atlas.js — shared by the display (index.html) and admin (admin.html):
// API calls, the sign-in screen, the editorial map style, and trip geometry helpers.
(function () {
  const BRAND = { family: "The Rey Family", name: "Travel Map" };

  // Embrace Strings palette, extended with a few muted route colors that sit well on paper.
  const C = {
    ink: "#16233D",
    gold: "#B99A6C",
    goldDeep: "#8C6F45",
    paper: "#EFEAE0",
    land: "#ECE5D6",
    water: "#C8D2D2",
    waterLine: "#9DAEB0",
    text: "#2A2F3A",
  };
  const ROUTE_COLORS = ["#1F3A5F", "#B5654A", "#5E7D6B", "#8C6F45", "#6B4E71", "#2F7A7A", "#9A4E5A", "#4F6A8F"];

  // ─── API ───────────────────────────────────────────────────────────────────
  async function api(action, { method = "GET", body, query = {} } = {}) {
    const qs = new URLSearchParams({ action, ...query }).toString();
    const r = await fetch(`/api/trips?${qs}`, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null;
    try {
      j = await r.json();
    } catch {}
    if (r.status === 401 && action !== "login") {
      await signIn();
      return api(action, { method, body, query });
    }
    if (!r.ok) throw new Error((j && j.error) || `Request failed (${r.status})`);
    return j;
  }

  const photoUrl = (p, v = "t") => `/api/trips?action=photo&trip=${encodeURIComponent(p.tripId)}&id=${encodeURIComponent(p.id)}&v=${v}`;

  // ─── Sign-in screen ────────────────────────────────────────────────────────
  let signing = null;
  function signIn() {
    if (signing) return signing;
    signing = new Promise((resolve) => {
      const el = document.createElement("div");
      el.className = "signin";
      el.innerHTML = `
        <form class="signin-card" autocomplete="on">
          <div class="signin-kicker">${BRAND.family}</div>
          <h1 class="signin-title">${BRAND.name}</h1>
          <div class="signin-rule"></div>
          <label class="signin-label" for="signin-pw">Family password</label>
          <input id="signin-pw" name="password" type="password" autocomplete="current-password" required>
          <button type="submit">Open the map</button>
          <p class="signin-error" role="alert"></p>
        </form>`;
      document.body.appendChild(el);
      const form = el.querySelector("form");
      const input = el.querySelector("input");
      const err = el.querySelector(".signin-error");
      setTimeout(() => input.focus(), 50);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        err.textContent = "";
        try {
          await api("login", { method: "POST", body: { password: input.value } });
          el.classList.add("leaving");
          setTimeout(() => el.remove(), 500);
          signing = null;
          resolve();
        } catch (ex) {
          err.textContent = ex.message;
          form.classList.remove("shake");
          void form.offsetWidth;
          form.classList.add("shake");
          input.select();
        }
      });
    });
    return signing;
  }

  async function ensureSession() {
    try {
      await api("session");
    } catch (e) {
      /* api() already showed the sign-in screen and retried */
    }
  }

  // ─── Map style ─────────────────────────────────────────────────────────────
  // A quiet, printed-atlas look on OpenFreeMap's free vector tiles: paper land, slate
  // water with engraved "waterlines" along the coast, faint relief, hairline borders.
  function mapStyle({ relief = true, waterlines = true, labels = true } = {}) {
    const font = (w) => [w === "i" ? "Noto Sans Italic" : w === "b" ? "Noto Sans Bold" : "Noto Sans Regular"];
    const isPoly = ["match", ["geometry-type"], ["MultiPolygon", "Polygon"], true, false];
    const isLine = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
    const layers = [
      { id: "background", type: "background", paint: { "background-color": C.land } },
    ];
    if (relief)
      layers.push({
        id: "relief",
        type: "raster",
        source: "relief",
        maxzoom: 9,
        paint: {
          "raster-saturation": -1,
          "raster-contrast": 0.15,
          "raster-brightness-min": 0.35,
          "raster-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0.28, 6, 0.2, 8.5, 0],
        },
      });
    layers.push(
      {
        id: "park",
        type: "fill",
        source: "omt",
        "source-layer": "park",
        filter: isPoly,
        paint: { "fill-color": "#DCDDC6", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.25, 10, 0.65] },
      },
      {
        id: "wood",
        type: "fill",
        source: "omt",
        "source-layer": "landcover",
        minzoom: 8,
        filter: ["all", isPoly, ["match", ["get", "class"], ["wood", "grass", "wetland"], true, false]],
        paint: { "fill-color": "#DEDCC8", "fill-opacity": 0.45 },
      },
      {
        id: "sand",
        type: "fill",
        source: "omt",
        "source-layer": "landcover",
        minzoom: 9,
        filter: ["all", isPoly, ["==", ["get", "class"], "sand"]],
        paint: { "fill-color": "#F3EBD8", "fill-opacity": 0.9 },
      },
      {
        id: "water",
        type: "fill",
        source: "omt",
        "source-layer": "water",
        filter: ["all", isPoly, ["!=", ["get", "brunnel"], "tunnel"]],
        paint: { "fill-color": C.water, "fill-antialias": true },
      }
    );
    if (waterlines)
      [1.6, 4.2, 7.4].forEach((off, i) =>
        layers.push({
          id: `waterline-${i}`,
          type: "line",
          source: "omt",
          "source-layer": "water",
          minzoom: 4,
          filter: ["all", isPoly, ["!=", ["get", "brunnel"], "tunnel"]],
          paint: {
            "line-color": C.waterLine,
            "line-width": 0.55,
            "line-offset": off,
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0, 5, [0.55, 0.35, 0.18][i], 13, [0.45, 0.25, 0.12][i]],
          },
        })
      );
    layers.push(
      {
        id: "coast",
        type: "line",
        source: "omt",
        "source-layer": "water",
        filter: ["all", isPoly, ["!=", ["get", "brunnel"], "tunnel"]],
        paint: { "line-color": "#8FA1A4", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.3, 10, 0.8], "line-opacity": 0.6 },
      },
      {
        id: "waterway",
        type: "line",
        source: "omt",
        "source-layer": "waterway",
        minzoom: 7,
        filter: isLine,
        paint: { "line-color": C.water, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.4, 14, 2] },
      },
      {
        id: "building",
        type: "fill",
        source: "omt",
        "source-layer": "building",
        minzoom: 14,
        paint: { "fill-color": "#E2D9C6", "fill-opacity": 0.6 },
      },
      {
        id: "road-minor",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 11,
        filter: ["all", isLine, ["match", ["get", "class"], ["minor", "service", "tertiary"], true, false]],
        paint: { "line-color": "#E4DAC6", "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 11, 0.4, 16, 5] },
      },
      {
        id: "road-major",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 7,
        filter: ["all", isLine, ["match", ["get", "class"], ["primary", "secondary", "trunk"], true, false]],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#DECFB2", "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 7, 0.4, 16, 7] },
      },
      {
        id: "road-motorway",
        type: "line",
        source: "omt",
        "source-layer": "transportation",
        minzoom: 4,
        filter: ["all", isLine, ["==", ["get", "class"], "motorway"]],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#D5C29E",
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 4, 0.35, 8, 1, 16, 9],
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 8, 0.9],
        },
      },
      {
        id: "boundary-state",
        type: "line",
        source: "omt",
        "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
        paint: {
          "line-color": "#B3A27F",
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 8, 1.1],
          "line-dasharray": [3, 2.5],
          "line-opacity": 0.75,
        },
      },
      {
        id: "boundary-country",
        type: "line",
        source: "omt",
        "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": "#9C8B6A", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 8, 1.6] },
      }
    );
    if (labels)
      layers.push(
        {
          id: "label-water",
          type: "symbol",
          source: "omt",
          "source-layer": "water_name",
          filter: ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
          layout: {
            "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
            "text-font": font("i"),
            "text-size": ["interpolate", ["linear"], ["zoom"], 3, 11, 8, 14],
            "text-letter-spacing": 0.18,
            "text-max-width": 7,
          },
          paint: { "text-color": "#6F8589", "text-halo-color": C.water, "text-halo-width": 1 },
        },
        {
          id: "label-state",
          type: "symbol",
          source: "omt",
          "source-layer": "place",
          minzoom: 3.5,
          maxzoom: 7.5,
          filter: ["==", ["get", "class"], "state"],
          layout: {
            "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
            "text-font": font("r"),
            "text-transform": "uppercase",
            "text-size": ["interpolate", ["linear"], ["zoom"], 3.5, 9, 7, 13],
            "text-letter-spacing": 0.35,
            "text-max-width": 8,
          },
          paint: { "text-color": "#A2957B", "text-halo-color": C.land, "text-halo-width": 1.2 },
        },
        {
          id: "label-town",
          type: "symbol",
          source: "omt",
          "source-layer": "place",
          minzoom: 8,
          filter: ["match", ["get", "class"], ["town", "village"], true, false],
          layout: {
            "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
            "text-font": font("r"),
            "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 14, 13],
          },
          paint: { "text-color": "#6E6A60", "text-halo-color": C.land, "text-halo-width": 1.4 },
        },
        {
          id: "label-city",
          type: "symbol",
          source: "omt",
          "source-layer": "place",
          minzoom: 4.5,
          filter: ["==", ["get", "class"], "city"],
          layout: {
            "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
            "text-font": font("r"),
            "text-size": ["interpolate", ["linear"], ["zoom"], 4.5, 10, 10, 14],
            "text-letter-spacing": 0.04,
          },
          paint: { "text-color": "#4E5361", "text-halo-color": C.land, "text-halo-width": 1.4 },
        },
        {
          id: "label-country",
          type: "symbol",
          source: "omt",
          "source-layer": "place",
          maxzoom: 6,
          filter: ["==", ["get", "class"], "country"],
          layout: {
            "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
            "text-font": font("r"),
            "text-transform": "uppercase",
            "text-size": 11,
            "text-letter-spacing": 0.5,
          },
          paint: { "text-color": "#8D8370", "text-halo-color": C.land, "text-halo-width": 1.2 },
        }
      );
    const style = {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: {
        omt: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
      },
      layers,
    };
    if (relief)
      style.sources.relief = {
        type: "raster",
        tiles: ["https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 6,
      };
    return style;
  }

  // ─── Dates ─────────────────────────────────────────────────────────────────
  const parseDate = (s) => {
    if (!s) return null;
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fmt = (s, opts) => (s ? parseDate(s).toLocaleDateString("en-US", opts) : "");
  const dayLabel = (day) => {
    if (!day) return "";
    const a = fmt(day.date, { weekday: "short", month: "short", day: "numeric" });
    if (!day.dateEnd || day.dateEnd === day.date) return a;
    return `${a} – ${fmt(day.dateEnd, { weekday: "short", day: "numeric" })}`;
  };
  const dayLong = (day) => {
    if (!day) return "";
    const a = fmt(day.date, { weekday: "long", month: "long", day: "numeric" });
    if (!day.dateEnd || day.dateEnd === day.date) return a;
    return `${a} – ${fmt(day.dateEnd, { weekday: "long", day: "numeric" })}`;
  };
  function dateRange(a, b) {
    const A = parseDate(a);
    const B = parseDate(b);
    if (!A) return "";
    if (!B) return fmt(a, { month: "long", day: "numeric", year: "numeric" });
    const sameMonth = A.getMonth() === B.getMonth() && A.getFullYear() === B.getFullYear();
    const left = fmt(a, { month: "long", day: "numeric" });
    const right = sameMonth ? B.getDate() : fmt(b, { month: "long", day: "numeric" });
    return `${left} – ${right}, ${B.getFullYear()}`;
  }

  // ─── Geometry ──────────────────────────────────────────────────────────────
  const hasXY = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
  function haversine(a, b) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toR;
    const dLng = (b[0] - a[0]) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bounds(points) {
    const pts = points.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!pts.length) return null;
    let [w, s] = pts[0];
    let [e, n] = pts[0];
    for (const [x, y] of pts) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
    return [
      [w, s],
      [e, n],
    ];
  }

  // Unique map locations for a trip, numbered in the order they were first reached.
  // Repeat nights at the same lodging collapse into one place with several visits.
  function places(trip) {
    const out = [];
    const byKey = new Map();
    const keyOf = (s) => `${(s.name || "").trim().toLowerCase()}|${s.lat.toFixed(3)}|${s.lng.toFixed(3)}`;
    const add = (s, stop) => {
      const k = keyOf(s);
      let p = byKey.get(k);
      if (!p) {
        p = { key: k, name: s.name, area: s.area, lat: s.lat, lng: s.lng, kind: s.kind, stops: [], days: [], groups: new Set() };
        byKey.set(k, p);
        out.push(p);
      }
      if (stop) {
        p.stops.push(stop);
        if (!p.days.includes(stop.day)) p.days.push(stop.day);
        p.groups.add(stop.group || null);
        if (stop.kind === "stay" && p.kind !== "home") p.kind = "stay";
        if (!p.area && stop.area) p.area = stop.area;
      }
      return p;
    };
    if (hasXY(trip.origin)) add({ ...trip.origin, name: trip.origin.name || "Home", kind: "home" }, null);
    const order = [...trip.stops].sort((a, b) => a.day - b.day);
    for (const s of order) if (hasXY(s)) add(s, s);
    let n = 0;
    for (const p of out) p.num = p.kind === "home" || p.kind === "airport" ? 0 : ++n;
    const byStop = new Map();
    for (const p of out) for (const s of p.stops) byStop.set(s.id, p);
    return { list: out, byStop };
  }

  function tripStats(trip) {
    const segs = (trip.route && trip.route.segments) || [];
    let meters = 0;
    let flown = 0;
    for (const s of segs) {
      let m = 0;
      if (Number.isFinite(s.distance)) m = s.distance;
      else for (let i = 1; i < s.coords.length; i++) m += haversine(s.coords[i - 1], s.coords[i]);
      if (s.mode === "fly") flown += m;
      else meters += m;
    }
    const A = parseDate(trip.startDate);
    const B = parseDate(trip.endDate);
    const nights = A && B ? Math.max(0, Math.round((B - A) / 864e5)) : 0;
    const pl = places(trip).list.filter((p) => p.kind !== "home" && p.kind !== "airport");
    return {
      miles: Math.round(meters / 1609.344),
      flown: Math.round(flown / 1609.344),
      countries: (trip.countries || []).length,
      nights,
      stops: pl.length,
      states: (trip.states || []).length,
      photos: (trip.photos || []).filter((p) => !p.hidden).length,
    };
  }

  // The part of a trip worth framing on the map. For trips that fly somewhere, that's the
  // destination: flights, airports and anything near home are left out.
  function focusPoints(trip, dayN = null) {
    const segs = ((trip.route && trip.route.segments) || []).filter((s) => dayN == null || s.day === dayN);
    const home = hasXY(trip.origin) ? [trip.origin.lng, trip.origin.lat] : null;
    const flies = segs.some((s) => s.mode === "fly");
    const near = (c) => home && haversine(home, c) < 150000;
    const pts = [];
    for (const s of segs) {
      if (flies && s.mode === "fly") continue;
      for (const c of s.coords) if (!(flies && dayN == null && near(c))) pts.push(c);
    }
    for (const st of trip.stops) {
      if (!hasXY(st) || (dayN != null && st.day !== dayN)) continue;
      const c = [st.lng, st.lat];
      if (flies && dayN == null && (st.kind === "airport" || st.kind === "home" || near(c))) continue;
      pts.push(c);
    }
    if (dayN != null && flies && !pts.length) for (const s of segs) pts.push(...s.coords);
    if (!pts.length) for (const s of segs) pts.push(...s.coords);
    return pts;
  }

  // Where the trip stands today, if it is underway.
  function today(trip, now = new Date()) {
    const t = ymd(now);
    if (!trip.startDate || !trip.endDate || t < trip.startDate || t > trip.endDate) return null;
    const day = trip.days.find((d) => t >= d.date && t <= (d.dateEnd || d.date)) || null;
    const dayIndex = Math.round((parseDate(t) - parseDate(trip.startDate)) / 864e5) + 1;
    const totalDays = Math.round((parseDate(trip.endDate) - parseDate(trip.startDate)) / 864e5) + 1;
    let where = [];
    if (day) {
      const stops = trip.stops.filter((s) => s.day === day.n && hasXY(s));
      const stays = stops.filter((s) => s.kind === "stay" || s.kind === "home");
      where = stays.length ? stays : stops.slice(-1);
    }
    return { date: t, day, dayIndex, totalDays, where };
  }

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // On trips.embracestrings.com the pages live at / and /admin; on any other host
  // (Vercel previews, tasks.embracestrings.com) they live under /trips/.
  const onTripsHost = /^trips\./.test(location.hostname) || location.hostname === "localhost";
  const home = onTripsHost ? "/" : "/trips/";
  const adminHome = onTripsHost ? "/admin" : "/trips/admin";

  window.Atlas = {
    BRAND,
    home,
    adminHome,
    C,
    ROUTE_COLORS,
    api,
    signIn,
    ensureSession,
    photoUrl,
    mapStyle,
    parseDate,
    ymd,
    fmt,
    dayLabel,
    dayLong,
    dateRange,
    hasXY,
    haversine,
    bounds,
    places,
    tripStats,
    focusPoints,
    today,
    esc,
  };
})();
