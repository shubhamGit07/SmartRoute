import assert from "node:assert/strict";
import { optimizeStops, fifoRoute, exactStops, Point } from "../src/optimizer.js";
import { summarize, pairedT } from "../src/stats.js";

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function gen(seed: number, orders: number, dropOnly = 0): Point[] {
  const r = rng(seed); const out: Point[] = [];
  for (let i = 0; i < orders; i++) {
    const pr = r() < 0.2 ? "EXPRESS" : "STANDARD";
    if (i >= dropOnly) out.push({ id: `p${i}`, orderId: `o${i}`, kind: "pickup", lat: 28.48 + r() * 0.22, lng: 77.28 + r() * 0.24, priority: pr as any });
    out.push({ id: `d${i}`, orderId: `o${i}`, kind: "drop", lat: 28.48 + r() * 0.22, lng: 77.28 + r() * 0.24, priority: pr as any });
  }
  return out;
}
const start: Point = { id: "s", orderId: "s", kind: "pickup", lat: 28.5355, lng: 77.391 };
const precedenceOk = (seq: Point[]) => seq.every((p, i) => p.kind === "pickup" || !seq.some((q, j) => q.orderId === p.orderId && q.kind === "pickup" && j > i));

let gaps: number[] = [], saves: number[] = [], fifoKm: number[] = [], optKm: number[] = [];
for (let seed = 1; seed <= 30; seed++) {
  const stops = gen(seed, 5); // 10 stops -> exact solvable
  const [f, o, e] = await Promise.all([fifoRoute(start, stops, { forceHaversine: true }), optimizeStops(start, stops, { forceHaversine: true }), exactStops(start, stops, { forceHaversine: true })]);
  assert.ok(precedenceOk(o.sequence), "heuristic broke precedence");
  assert.ok(precedenceOk(e!.sequence), "exact broke precedence");
  assert.equal(o.sequence.length, stops.length);
  assert.ok(e!.distanceKm <= o.distanceKm + 1e-6, "exact must be <= heuristic");
  assert.ok(o.distanceKm <= f.distanceKm + 1e-6, "heuristic must be <= FIFO");
  gaps.push(((o.distanceKm - e!.distanceKm) / e!.distanceKm) * 100);
  saves.push(((f.distanceKm - o.distanceKm) / f.distanceKm) * 100);
  fifoKm.push(f.distanceKm); optKm.push(o.distanceKm);
}
console.log("optimality gap vs exact (%):", summarize(gaps));
console.log("saving vs FIFO (%):", summarize(saves));
console.log("paired t FIFO vs OPT:", pairedT(fifoKm, optKm));

// drop-only (already picked-up) orders must be accepted and handled
const mixed = gen(99, 6, 3);
const m = await optimizeStops(start, mixed, { forceHaversine: true });
assert.equal(m.sequence.length, mixed.length); assert.ok(precedenceOk(m.sequence));
console.log("drop-only orders OK, stops:", m.sequence.length);

// timing for 50 orders (100 stops)
const big = gen(7, 50); const t0 = performance.now();
const b = await optimizeStops(start, big, { forceHaversine: true });
assert.ok(precedenceOk(b.sequence), "50-order stress test violated pickup/drop precedence");
assert.equal(b.sequence.length, big.length, "50-order optimizer must include every stop");
console.log("50 orders:", b.distanceKm.toFixed(1), "km in", (performance.now() - t0).toFixed(0), "ms", precedenceOk(b.sequence));
