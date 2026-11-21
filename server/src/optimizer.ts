/**
 * SmartRoute route-optimization engine.
 *
 * - OSRM road distance/time matrix with per-edge fallback
 * - FIFO baseline and precedence-aware Nearest Neighbor + 2-opt
 * - Express orders receive a bounded preference during initial construction
 * - Matrix cache with TTL and a bounded entry count
 *
 * Compatible result shape: sequence, distanceKm, durationMinutes, matrix.
 */

export type Point = {
  id: string;
  lat: number;
  lng: number;
  kind: "pickup" | "drop";
  orderId: string;
  priority?: "STANDARD" | "EXPRESS";
};

type Matrix = {
  distance: number[][]; // meters
  duration: number[][]; // seconds
  source: "OSRM" | "HAVERSINE_FALLBACK" | "OSRM_PARTIAL_FALLBACK";
};

type RouteResult = {
  sequence: Point[];
  distanceKm: number;
  durationMinutes: number;
  matrix: Matrix;
};

type MatrixCacheEntry = { value: Matrix; createdAt: number };


const runtimeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const OSRM_BASE = (runtimeEnv?.OSRM_BASE || "https://router.project-osrm.org").replace(/\/$/, "");
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const FALLBACK_SPEED_KMPH = 25;
const ROAD_FACTOR = 1.25;
const EXPRESS_PREFERENCE_KM = 2.0;
const TWO_OPT_MAX_ITERATIONS = 100;
const matrixCache = new Map<string, MatrixCacheEntry>();


export const haversineKm = (a: Point, b: Point): number => {
  const earthRadiusKm = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
};

function validatePoints(start: Point, stops: Point[]): void {
  if (!start || !Array.isArray(stops)) {
    throw new Error("A start point and stops array are required.");
  }

  const all = [start, ...stops];
  for (const point of all) {
    if (!point || typeof point.id !== "string" || !point.id.trim()) {
      throw new Error("Every point must have a non-empty id.");
    }
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      throw new Error(`Invalid coordinates for point ${point.id}.`);
    }
    if (point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) {
      throw new Error(`Coordinates out of range for point ${point.id}.`);
    }
    if (point.kind !== "pickup" && point.kind !== "drop") {
      throw new Error(`Point ${point.id} must be pickup or drop.`);
    }
    if (typeof point.orderId !== "string" || !point.orderId.trim()) {
      throw new Error(`Point ${point.id} is missing orderId.`);
    }
    if (point.priority !== undefined && point.priority !== "STANDARD" && point.priority !== "EXPRESS") {
      throw new Error(`Invalid priority for point ${point.id}.`);
    }
  }

  const ids = new Set<string>();
  for (const point of all) {
    if (ids.has(point.id)) throw new Error(`Duplicate point id: ${point.id}`);
    ids.add(point.id);
  }

  const byOrder = new Map<string, { pickups: number; drops: number }>();
  for (const point of stops) {
    const counts = byOrder.get(point.orderId) ?? { pickups: 0, drops: 0 };
    if (point.kind === "pickup") counts.pickups++;
    else counts.drops++;
    byOrder.set(point.orderId, counts);
  }

  for (const [orderId, counts] of byOrder) {
    if (counts.pickups !== 1 || counts.drops !== 1) {
      throw new Error(`Order ${orderId} must have exactly one pickup and one drop in the stops.`);
    }
  }
}


function cacheKey(points: Point[]): string {
  // Ordering is significant because matrix rows/columns correspond to this exact order.
  return points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
}

function fallbackEdgeMeters(a: Point, b: Point): number {
  return haversineKm(a, b) * 1000 * ROAD_FACTOR;
}
function fallbackEdgeSeconds(distanceMeters: number): number {
  return (distanceMeters / 1000 / FALLBACK_SPEED_KMPH) * 3600;
}
function trimCache(now: number): void {
  for (const [key, entry] of matrixCache) {
    if (now - entry.createdAt > CACHE_TTL_MS) matrixCache.delete(key);
  }
  while (matrixCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = matrixCache.keys().next().value;
    if (oldestKey === undefined) break;
    matrixCache.delete(oldestKey);
  }
}


async function tableMatrix(points: Point[]): Promise<Matrix> {
  const key = cacheKey(points);
  const now = Date.now();
  const cached = matrixCache.get(key);
  if (cached && now - cached.createdAt <= CACHE_TTL_MS) return cached.value;
  if (cached) matrixCache.delete(key);
  trimCache(now);

  const count = points.length;
  const fallbackDistance = points.map((a) => points.map((b) => fallbackEdgeMeters(a, b)));
  const fallbackDuration = fallbackDistance.map((row) => row.map(fallbackEdgeSeconds));

  if (count < 2) {
    const result: Matrix = {
      distance: fallbackDistance,
      duration: fallbackDuration,
      source: "HAVERSINE_FALLBACK",
    };
    matrixCache.set(key, { value: result, createdAt: Date.now() });
    return result;
  }

  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  try {
    const response = await fetch(
      `${OSRM_BASE}/table/v1/driving/${coords}?annotations=distance,duration`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) throw new Error(`OSRM table request failed (${response.status})`);
    const data = await response.json();
    if (!Array.isArray(data.distances) || !Array.isArray(data.durations)) {
      throw new Error("OSRM returned an invalid matrix.");
    }

    const distance = fallbackDistance.map((row, i) => row.map((fallback, j) => {
      const value = data.distances?.[i]?.[j];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
    }));
    const duration = fallbackDuration.map((row, i) => row.map((fallback, j) => {
      const value = data.durations?.[i]?.[j];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
    }));

    const complete = distance.every((row, i) => row.every((_, j) =>
      typeof data.distances?.[i]?.[j] === "number" &&
      Number.isFinite(data.distances[i][j]) &&
      typeof data.durations?.[i]?.[j] === "number" &&
      Number.isFinite(data.durations[i][j])
    ));
    const result: Matrix = {
      distance,
      duration,
      source: complete ? "OSRM" : "OSRM_PARTIAL_FALLBACK",
    };
    matrixCache.set(key, { value: result, createdAt: Date.now() });
    return result;
  } catch {
    const result: Matrix = {
      distance: fallbackDistance,
      duration: fallbackDuration,
      source: "HAVERSINE_FALLBACK",
    };
    matrixCache.set(key, { value: result, createdAt: Date.now() });
    return result;
  }
}


function routeCost(route: number[], distanceMeters: number[][]): number {
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    total += distanceMeters[route[i - 1]][route[i]];
  }
  return total;
}

function validPrecedence(route: number[], stops: Point[]): boolean {
  const position = new Map<number, number>();
  route.forEach((node, index) => position.set(node, index));
  const pickupByOrder = new Map<string, number>();
  const dropByOrder = new Map<string, number>();

  stops.forEach((stop, index) => {
    if (stop.kind === "pickup") pickupByOrder.set(stop.orderId, index + 1);
    else dropByOrder.set(stop.orderId, index + 1);
  });

  for (const [orderId, dropIndex] of dropByOrder) {
    const pickupIndex = pickupByOrder.get(orderId);
    if (pickupIndex === undefined) return false;
    const pickupPosition = position.get(pickupIndex);
    const dropPosition = position.get(dropIndex);
    if (pickupPosition === undefined || dropPosition === undefined || pickupPosition >= dropPosition) {
      return false;
    }
  }
  return true;
}


function buildInitialRoute(stops: Point[], distanceKm: number[][]): number[] {
  const remaining = new Set(stops.map((_, index) => index + 1));
  const pickedOrders = new Set<string>();
  const route = [0];

  while (remaining.size > 0) {
    const current = route[route.length - 1];
    const eligible = [...remaining].filter((index) => {
      const stop = stops[index - 1];
      return stop.kind === "pickup" || pickedOrders.has(stop.orderId);
    });
    if (eligible.length === 0) throw new Error("No eligible stop found; check pickup/drop data.");

    eligible.sort((a, b) => {
      const stopA = stops[a - 1];
      const stopB = stops[b - 1];
      const distA = distanceKm[current][a];
      const distB = distanceKm[current][b];
      const expressA = stopA.priority === "EXPRESS" ? 1 : 0;
      const expressB = stopB.priority === "EXPRESS" ? 1 : 0;
      // Express is preferred only when its extra travel cost is within this bounded allowance.
      const scoreA = distA - expressA * EXPRESS_PREFERENCE_KM;
      const scoreB = distB - expressB * EXPRESS_PREFERENCE_KM;
      return scoreA - scoreB || distA - distB || a - b;
    });

    const next = eligible[0];
    route.push(next);
    remaining.delete(next);
    const chosen = stops[next - 1];
    if (chosen.kind === "pickup") pickedOrders.add(chosen.orderId);
  }
  return route;
}


function improveWithTwoOpt(route: number[], stops: Point[], distanceKm: number[][]): number[] {
  const bestRoute = route.slice();
  let bestCost = routeCost(bestRoute, distanceKm);
  let iterations = 0;
  let improved = true;

  while (improved && iterations < TWO_OPT_MAX_ITERATIONS) {
    improved = false;
    iterations++;
    outer: for (let i = 1; i < bestRoute.length - 1; i++) {
      for (let k = i + 1; k < bestRoute.length; k++) {
        const candidate = [
          ...bestRoute.slice(0, i),
          ...bestRoute.slice(i, k + 1).reverse(),
          ...bestRoute.slice(k + 1),
        ];
        if (!validPrecedence(candidate, stops)) continue;
        const candidateCost = routeCost(candidate, distanceKm);
        if (candidateCost + 1e-6 < bestCost) {
          bestRoute.splice(0, bestRoute.length, ...candidate);
          bestCost = candidateCost;
          improved = true;
          break outer;
        }
      }
    }
  }
  return bestRoute;
}


function calculateRouteMetrics(route: number[], matrix: Matrix): { distanceKm: number; durationMinutes: number } {
  let distanceMeters = 0;
  let durationSeconds = 0;
  for (let i = 1; i < route.length; i++) {
    distanceMeters += matrix.distance[route[i - 1]][route[i]];
    durationSeconds += matrix.duration[route[i - 1]][route[i]];
  }
  return { distanceKm: distanceMeters / 1000, durationMinutes: durationSeconds / 60 };
}


export async function optimizeStops(start: Point, stops: Point[]): Promise<RouteResult> {
  validatePoints(start, stops);
  if (stops.length === 0) {
    return {
      sequence: [],
      distanceKm: 0,
      durationMinutes: 0,
      matrix: { distance: [[0]], duration: [[0]], source: "HAVERSINE_FALLBACK" },
    };
  }

  const all = [start, ...stops];
  const matrix = await tableMatrix(all);
  const distanceKm = matrix.distance.map((row) => row.map((meters) => meters / 1000));
  const initial = buildInitialRoute(stops, distanceKm);
  const optimized = improveWithTwoOpt(initial, stops, distanceKm);
  const metrics = calculateRouteMetrics(optimized, matrix);
  return { sequence: optimized.slice(1).map((index) => stops[index - 1]), ...metrics, matrix };
}


export async function fifoRoute(start: Point, stops: Point[]): Promise<RouteResult> {
  validatePoints(start, stops);
  if (stops.length === 0) {
    return {
      sequence: [],
      distanceKm: 0,
      durationMinutes: 0,
      matrix: { distance: [[0]], duration: [[0]], source: "HAVERSINE_FALLBACK" },
    };
  }

  const all = [start, ...stops];
  const matrix = await tableMatrix(all);
  const route = [0, ...stops.map((_, index) => index + 1)];
  const metrics = calculateRouteMetrics(route, matrix);
  return { sequence: stops.slice(), ...metrics, matrix };
}


/** Returns route geometry in Leaflet format: [latitude, longitude]. */
export async function getRoadRoute(points: Point[]): Promise<[number, number][]> {
  if (!Array.isArray(points) || points.length === 0) return [];
  for (const point of points) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) ||
      point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) {
      throw new Error("Invalid point passed to getRoadRoute.");
    }
  }
  if (points.length === 1) return [[points[0].lat, points[0].lng]];

  const coords = points.map((point) => `${point.lng},${point.lat}`).join(";");
  try {
    const response = await fetch(
      `${OSRM_BASE}/route/v1/driving/${coords}?overview=full&geometries=geojson`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) throw new Error(`OSRM route request failed (${response.status})`);
    const json = await response.json();
    const routeCoordinates = json.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(routeCoordinates) || routeCoordinates.length < 2) {
      throw new Error("OSRM returned no route geometry.");
    }
    return routeCoordinates.map(([lng, lat]: [number, number]) => [lat, lng]);
  } catch {
    // This fallback is a straight line between stops, not road geometry.
    return points.map((point) => [point.lat, point.lng]);
  }
}
