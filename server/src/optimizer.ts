/**
 * SmartRoute route-optimization engine (v2).
 *
 * Algorithms
 *  - FIFO baseline (stops in insertion order)
 *  - Precedence-aware Nearest Neighbour construction (express bias)
 *  - 2-opt + Or-opt local search (precedence preserved, O(1) delta pre-filter)
 *  - Exact Held-Karp DP for small instances (<= EXACT_MAX_STOPS) -> optimality gap
 *
 * Data
 *  - OSRM /table with CHUNKING (public demo server caps a request at 100 coords,
 *    so 50 orders = 101 points used to silently fall back to Haversine before)
 *  - Per-edge Haversine fallback, TTL + bounded cache
 *  - `forceHaversine` option for reproducible, network-free experiments
 *
 * A stop may be a drop only (order already picked up): `validatePoints` accepts
 * orders that have just a drop, which fixes mid-route re-optimisation.
 */
export type Point = {
  id: string;
  lat: number;
  lng: number;
  kind: "pickup" | "drop";
  orderId: string;
  priority?: "STANDARD" | "EXPRESS";
};

export type Matrix = {
  distance: number[][]; // meters
  duration: number[][]; // seconds
  source: "OSRM" | "HAVERSINE_FALLBACK" | "OSRM_PARTIAL_FALLBACK";
};

export type RouteResult = {
  sequence: Point[];
  distanceKm: number;
  durationMinutes: number;
  matrix: Matrix;
  method?: string;
};

export type OptimizeOptions = { forceHaversine?: boolean; matrix?: Matrix };

type MatrixCacheEntry = { value: Matrix; createdAt: number };

const runtimeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const OSRM_BASE = (runtimeEnv?.OSRM_BASE || "https://router.project-osrm.org").replace(/\/$/, "");
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const FALLBACK_SPEED_KMPH = 25;
const ROAD_FACTOR = 1.25;
const EXPRESS_PREFERENCE_KM = 2.0;
const TWO_OPT_MAX_PASSES = 200;
const OSRM_CHUNK = 50; // 50x50 = 2500 cells per request, well inside public limits
const EXACT_MAX_STOPS = 14; // 2^14 * 14 states: milliseconds

const matrixCache = new Map<string, MatrixCacheEntry>();

export const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */
function validatePoints(start: Point, stops: Point[]): void {
  if (!start || !Array.isArray(stops)) throw new Error("A start point and stops array are required.");
  const all = [start, ...stops];
  const ids = new Set<string>();
  for (const p of all) {
    if (!p || typeof p.id !== "string" || !p.id.trim()) throw new Error("Every point must have a non-empty id.");
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) throw new Error(`Invalid coordinates for point ${p.id}.`);
    if (p.lat < -90 || p.lat > 90 || p.lng < -180 || p.lng > 180) throw new Error(`Coordinates out of range for point ${p.id}.`);
    if (p.kind !== "pickup" && p.kind !== "drop") throw new Error(`Point ${p.id} must be pickup or drop.`);
    if (typeof p.orderId !== "string" || !p.orderId.trim()) throw new Error(`Point ${p.id} is missing orderId.`);
    if (p.priority !== undefined && p.priority !== "STANDARD" && p.priority !== "EXPRESS") {
      throw new Error(`Invalid priority for point ${p.id}.`);
    }
    if (ids.has(p.id)) throw new Error(`Duplicate point id: ${p.id}`);
    ids.add(p.id);
  }
  const byOrder = new Map<string, { pickups: number; drops: number }>();
  for (const p of stops) {
    const c = byOrder.get(p.orderId) ?? { pickups: 0, drops: 0 };
    if (p.kind === "pickup") c.pickups++;
    else c.drops++;
    byOrder.set(p.orderId, c);
  }
  for (const [orderId, c] of byOrder) {
    // drop-only is legal: the parcel is already on the rider's bike
    if (c.drops !== 1 || c.pickups > 1) {
      throw new Error(`Order ${orderId} must have exactly one drop and at most one pickup.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Distance matrix                                                     */
/* ------------------------------------------------------------------ */
const cacheKey = (pts: Point[]) => pts.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
const fallbackEdgeMeters = (a: Point, b: Point) => haversineKm(a, b) * 1000 * ROAD_FACTOR;
const fallbackEdgeSeconds = (m: number) => (m / 1000 / FALLBACK_SPEED_KMPH) * 3600;

function trimCache(now: number): void {
  for (const [k, e] of matrixCache) if (now - e.createdAt > CACHE_TTL_MS) matrixCache.delete(k);
  while (matrixCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = matrixCache.keys().next().value;
    if (oldest === undefined) break;
    matrixCache.delete(oldest);
  }
}

export function haversineMatrix(points: Point[]): Matrix {
  const distance = points.map((a) => points.map((b) => (a === b ? 0 : fallbackEdgeMeters(a, b))));
  const duration = distance.map((row) => row.map(fallbackEdgeSeconds));
  return { distance, duration, source: "HAVERSINE_FALLBACK" };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

async function osrmBlock(points: Point[], src: number[], dst: number[]) {
  // Request only the needed sources/destinations; coordinates are listed once.
  const used = [...new Set([...src, ...dst])];
  const pos = new Map(used.map((g, i) => [g, i]));
  const coords = used.map((g) => `${points[g].lng},${points[g].lat}`).join(";");
  const s = src.map((g) => pos.get(g)).join(";");
  const d = dst.map((g) => pos.get(g)).join(";");
  const url = `${OSRM_BASE}/table/v1/driving/${coords}?annotations=distance,duration&sources=${s}&destinations=${d}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`OSRM table failed (${res.status})`);
  const json: any = await res.json();
  if (!Array.isArray(json.distances) || !Array.isArray(json.durations)) throw new Error("Invalid OSRM matrix");
  return json as { distances: (number | null)[][]; durations: (number | null)[][] };
}

export async function tableMatrix(points: Point[], forceHaversine = false): Promise<Matrix> {
  if (forceHaversine || points.length < 2) return haversineMatrix(points);

  const key = cacheKey(points);
  const now = Date.now();
  const hit = matrixCache.get(key);
  if (hit && now - hit.createdAt <= CACHE_TTL_MS) return hit.value;
  if (hit) matrixCache.delete(key);
  trimCache(now);

  const fb = haversineMatrix(points);
  const n = points.length;
  const distance = fb.distance.map((r) => r.slice());
  const duration = fb.duration.map((r) => r.slice());
  let okCells = 0;
  let anyOk = false;

  const blocks: [number[], number[]][] = [];
  for (let i = 0; i < n; i += OSRM_CHUNK) {
    for (let j = 0; j < n; j += OSRM_CHUNK) {
      blocks.push([range(i, Math.min(n, i + OSRM_CHUNK)), range(j, Math.min(n, j + OSRM_CHUNK))]);
    }
  }
  // limited concurrency to stay polite to public OSRM
  const queue = blocks.slice();
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const [src, dst] = b;
      try {
        const json = await osrmBlock(points, src, dst);
        src.forEach((gi, a) =>
          dst.forEach((gj, c) => {
            const dv = json.distances?.[a]?.[c];
            const tv = json.durations?.[a]?.[c];
            if (typeof dv === "number" && Number.isFinite(dv) && dv >= 0) {
              distance[gi][gj] = dv;
              okCells++;
            }
            if (typeof tv === "number" && Number.isFinite(tv) && tv >= 0) duration[gi][gj] = tv;
          }),
        );
        anyOk = true;
      } catch {
        /* this block keeps Haversine values */
      }
    }
  };
  await Promise.all([worker(), worker()]);

  const source: Matrix["source"] = !anyOk ? "HAVERSINE_FALLBACK" : okCells === n * n ? "OSRM" : "OSRM_PARTIAL_FALLBACK";
  const result: Matrix = { distance, duration, source };
  matrixCache.set(key, { value: result, createdAt: Date.now() });
  return result;
}

/* ------------------------------------------------------------------ */
/* Route helpers (node 0 = start, node i = stops[i-1])                */
/* ------------------------------------------------------------------ */
function routeCost(route: number[], d: number[][]): number {
  let t = 0;
  for (let i = 1; i < route.length; i++) t += d[route[i - 1]][route[i]];
  return t;
}

/** precedence[drop] = pickup node that must come first (if the order has a pickup stop). */
function buildPrecedence(stops: Point[]): Map<number, number> {
  const pickup = new Map<string, number>();
  stops.forEach((s, i) => s.kind === "pickup" && pickup.set(s.orderId, i + 1));
  const prec = new Map<number, number>();
  stops.forEach((s, i) => {
    if (s.kind === "drop" && pickup.has(s.orderId)) prec.set(i + 1, pickup.get(s.orderId)!);
  });
  return prec;
}

function validPrecedence(route: number[], prec: Map<number, number>): boolean {
  const pos = new Map<number, number>();
  route.forEach((n, i) => pos.set(n, i));
  for (const [drop, pick] of prec) if ((pos.get(pick) ?? 1e9) >= (pos.get(drop) ?? -1)) return false;
  return true;
}

function buildInitialRoute(stops: Point[], dKm: number[][]): number[] {
  const remaining = new Set(stops.map((_, i) => i + 1));
  const prec = buildPrecedence(stops);
  const done = new Set<number>();
  const route = [0];
  while (remaining.size) {
    const cur = route[route.length - 1];
    let best = -1;
    let bestScore = Infinity;
    for (const i of remaining) {
      const need = prec.get(i);
      if (need !== undefined && !done.has(need)) continue;
      const express = stops[i - 1].priority === "EXPRESS" ? EXPRESS_PREFERENCE_KM : 0;
      const score = dKm[cur][i] - express;
      if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && i < best)) {
        best = i;
        bestScore = score;
      }
    }
    if (best < 0) throw new Error("No eligible stop found; check pickup/drop data.");
    route.push(best);
    remaining.delete(best);
    done.add(best);
  }
  return route;
}

/** 2-opt (segment reversal) followed by Or-opt (move a block of 1-3 stops), repeated to a local optimum. */
function localSearch(initial: number[], prec: Map<number, number>, d: number[][]): number[] {
  let route = initial.slice();
  let cost = routeCost(route, d);
  const EPS = 1e-6;

  for (let pass = 0; pass < TWO_OPT_MAX_PASSES; pass++) {
    let improved = false;

    // --- 2-opt: reverse route[i..k]; delta in O(1), precedence checked only for promising moves
    for (let i = 1; i < route.length - 1 && !improved; i++) {
      for (let k = i + 1; k < route.length && !improved; k++) {
        const a = route[i - 1], b = route[i], c = route[k], e = k + 1 < route.length ? route[k + 1] : -1;
        // open path: edge (c,e) only exists when e exists; reversed path is asymmetric so recompute segment
        let delta = d[a][c] - d[a][b];
        if (e >= 0) delta += d[b][e] - d[c][e];
        // matrix may be asymmetric (one-way streets): add the inside-segment change
        for (let t = i; t < k; t++) delta += d[route[t + 1]][route[t]] - d[route[t]][route[t + 1]];
        if (delta < -EPS) {
          const cand = [...route.slice(0, i), ...route.slice(i, k + 1).reverse(), ...route.slice(k + 1)];
          if (validPrecedence(cand, prec)) {
            route = cand;
            cost += delta;
            improved = true;
          }
        }
      }
    }

    // --- Or-opt: move block [i, i+len) to another position (optionally keeping orientation)
    if (!improved) {
      outer: for (let len = 1; len <= 3; len++) {
        for (let i = 1; i + len <= route.length; i++) {
          const block = route.slice(i, i + len);
          const rest = [...route.slice(0, i), ...route.slice(i + len)];
          for (let j = 1; j <= rest.length; j++) {
            if (j === i) continue;
            const cand = [...rest.slice(0, j), ...block, ...rest.slice(j)];
            const c2 = routeCost(cand, d);
            if (c2 + EPS < cost && validPrecedence(cand, prec)) {
              route = cand;
              cost = c2;
              improved = true;
              break outer;
            }
          }
        }
      }
    }
    if (!improved) break;
  }
  return route;
}

/** Exact optimum with precedence via Held-Karp bitmask DP. Returns null when too large. */
function exactRoute(stops: Point[], d: number[][]): number[] | null {
  const n = stops.length;
  if (n === 0 || n > EXACT_MAX_STOPS) return null;
  const prec = buildPrecedence(stops);
  const needMask = new Array(n).fill(0);
  for (const [drop, pick] of prec) needMask[drop - 1] = 1 << (pick - 1);
  const FULL = (1 << n) - 1;
  const dp = new Float64Array((FULL + 1) * n).fill(Infinity);
  const parent = new Int16Array((FULL + 1) * n).fill(-1);
  for (let j = 0; j < n; j++) if (needMask[j] === 0) dp[(1 << j) * n + j] = d[0][j + 1];
  for (let mask = 1; mask <= FULL; mask++) {
    for (let last = 0; last < n; last++) {
      const cur = dp[mask * n + last];
      if (cur === Infinity || !(mask & (1 << last))) continue;
      for (let nx = 0; nx < n; nx++) {
        if (mask & (1 << nx)) continue;
        if ((needMask[nx] & mask) !== needMask[nx]) continue;
        const nm = mask | (1 << nx);
        const v = cur + d[last + 1][nx + 1];
        if (v < dp[nm * n + nx]) {
          dp[nm * n + nx] = v;
          parent[nm * n + nx] = last;
        }
      }
    }
  }
  let bestLast = -1, best = Infinity;
  for (let j = 0; j < n; j++) if (dp[FULL * n + j] < best) { best = dp[FULL * n + j]; bestLast = j; }
  if (bestLast < 0) return null;
  const order: number[] = [];
  let mask = FULL, last = bestLast;
  while (last >= 0) {
    order.push(last + 1);
    const p = parent[mask * n + last];
    mask &= ~(1 << last);
    last = p;
  }
  return [0, ...order.reverse()];
}

function metrics(route: number[], m: Matrix) {
  let dm = 0, ds = 0;
  for (let i = 1; i < route.length; i++) {
    dm += m.distance[route[i - 1]][route[i]];
    ds += m.duration[route[i - 1]][route[i]];
  }
  return { distanceKm: dm / 1000, durationMinutes: ds / 60 };
}

const emptyResult = (): RouteResult => ({
  sequence: [], distanceKm: 0, durationMinutes: 0,
  matrix: { distance: [[0]], duration: [[0]], source: "HAVERSINE_FALLBACK" },
});

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */
export async function optimizeStops(start: Point, stops: Point[], opts: OptimizeOptions = {}): Promise<RouteResult> {
  validatePoints(start, stops);
  if (stops.length === 0) return emptyResult();
  const matrix = opts.matrix ?? (await tableMatrix([start, ...stops], opts.forceHaversine));
  const dKm = matrix.distance.map((r) => r.map((m) => m / 1000));
  const prec = buildPrecedence(stops);
  const route = localSearch(buildInitialRoute(stops, dKm), prec, dKm);
  return { sequence: route.slice(1).map((i) => stops[i - 1]), ...metrics(route, matrix), matrix, method: "NN+2opt+Oropt" };
}

/** Provably optimal route for small instances; null if the instance is too large. */
export async function exactStops(start: Point, stops: Point[], opts: OptimizeOptions = {}): Promise<RouteResult | null> {
  validatePoints(start, stops);
  if (stops.length === 0) return emptyResult();
  const matrix = opts.matrix ?? (await tableMatrix([start, ...stops], opts.forceHaversine));
  const dKm = matrix.distance.map((r) => r.map((m) => m / 1000));
  const route = exactRoute(stops, dKm);
  if (!route) return null;
  return { sequence: route.slice(1).map((i) => stops[i - 1]), ...metrics(route, matrix), matrix, method: "HELD_KARP_EXACT" };
}

export async function fifoRoute(start: Point, stops: Point[], opts: OptimizeOptions = {}): Promise<RouteResult> {
  validatePoints(start, stops);
  if (stops.length === 0) return emptyResult();
  const matrix = opts.matrix ?? (await tableMatrix([start, ...stops], opts.forceHaversine));
  const route = [0, ...stops.map((_, i) => i + 1)];
  return { sequence: stops.slice(), ...metrics(route, matrix), matrix, method: "FIFO" };
}

/** Road geometry in Leaflet [lat, lng] order. Falls back to straight lines. */
export async function getRoadRoute(points: Point[]): Promise<[number, number][]> {
  if (!Array.isArray(points) || points.length === 0) return [];
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || p.lat < -90 || p.lat > 90 || p.lng < -180 || p.lng > 180) {
      throw new Error("Invalid point passed to getRoadRoute.");
    }
  }
  if (points.length === 1) return [[points[0].lat, points[0].lng]];
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  try {
    const res = await fetch(`${OSRM_BASE}/route/v1/driving/${coords}?overview=full&geometries=geojson`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`OSRM route failed (${res.status})`);
    const json: any = await res.json();
    const c = json.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) throw new Error("No geometry");
    return c.map(([lng, lat]: [number, number]) => [lat, lng]);
  } catch {
    return points.map((p) => [p.lat, p.lng]);
  }
}
