import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'http';
import { Server } from 'socket.io';
import { z } from 'zod';
import { prisma } from './db.js';
import { optimizeStops, fifoRoute, exactStops, getRoadRoute, tableMatrix, haversineKm, Point } from './optimizer.js';
import { summarize, pairedT } from './stats.js';

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct rate-limit IPs

/* ------------------------------------------------------------------ */
/* CORS (normalises trailing slashes, optional *.vercel.app previews)  */
/* ------------------------------------------------------------------ */
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const allowVercelPreviews = process.env.ALLOW_VERCEL_PREVIEWS === 'true';
const originCheck = (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => {
  if (!origin) return cb(null, true); // curl, health checks
  const clean = origin.replace(/\/+$/, '');
  if (allowedOrigins.includes(clean)) return cb(null, true);
  if (allowVercelPreviews && /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(clean)) return cb(null, true);
  return cb(new Error(`Origin ${origin} not allowed by CORS`));
};
const io = new Server(server, { cors: { origin: originCheck, methods: ['GET', 'POST', 'PATCH'] } });

app.use(helmet());
app.use(cors({ origin: originCheck }));
app.use(express.json({ limit: '100kb' }));

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
const heavyLimiter = rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: true, legacyHeaders: false });
const geoLimiter = rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

const center = { lat: 28.5355, lng: 77.391 };
const ORDER_STATUSES = ['PENDING', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const apiError = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const validCoordinate = (lat: unknown, lng: unknown) =>
  isFiniteNumber(lat) && isFiniteNumber(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

/** Never send password hashes or e-mails to the browser. */
const publicUser = { select: { id: true, name: true, role: true } } as const;
const orderInclude = {
  customer: publicUser,
  rider: { include: { user: publicUser } },
} as const;

// Fare model (single source of truth; mirrors the client's preview formula)
function quote(pickup: { lat: number; lng: number }, drop: { lat: number; lng: number }, priority: 'STANDARD' | 'EXPRESS') {
  const roadKm = haversineKm(pickup, drop) * 1.25;
  const fare = Math.round((35 + roadKm * 10 + (priority === 'EXPRESS' ? 25 : 0)) * 100) / 100;
  const etaMinutes = Math.max(10, Math.round((roadKm / 22) * 60));
  return { roadKm, fare, etaMinutes };
}

async function getDemoRider() {
  const email = 'demo-rider@smartroute.local';
  const find = () => prisma.rider.findFirst({ where: { user: { email } }, include: { user: publicUser } });
  const existing = await find();
  if (existing) return existing;
  try {
    await prisma.user.create({
      data: { name: 'Demo Rider', email, passwordHash: null, role: 'RIDER', riderProfile: { create: { available: true } } },
    });
  } catch {
    /* two requests raced on the unique e-mail: fine, the other one won */
  }
  return (await find())!;
}

const statusTimestamps = (s: OrderStatus) => {
  const now = new Date();
  return s === 'ACCEPTED' ? { acceptedAt: now } : s === 'PICKED_UP' ? { pickedUpAt: now }
    : s === 'DELIVERED' ? { deliveredAt: now } : s === 'CANCELLED' ? { cancelledAt: now } : {};
};

/** Active orders -> stops. Parcels already picked up only need a DROP stop (bug fix). */
function orderPoints(orders: any[]): Point[] {
  return orders.flatMap((o) => {
    const drop: Point = { id: `d-${o.id}`, lat: o.dropLat, lng: o.dropLng, kind: 'drop', orderId: o.id, priority: o.priority };
    if (o.status === 'PICKED_UP' || o.status === 'IN_TRANSIT') return [drop];
    return [{ id: `p-${o.id}`, lat: o.pickupLat, lng: o.pickupLng, kind: 'pickup' as const, orderId: o.id, priority: o.priority }, drop];
  });
}

// --- debounced realtime pushes (a burst of writes -> one broadcast) ---
let pushTimer: NodeJS.Timeout | null = null;
function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try {
      io.emit('orders:update', { at: Date.now() });
      io.emit('routes:update', { at: Date.now() });
    } catch (e) { console.error('push failed', e); }
  }, 300);
}

/* ------------------------------------------------------------------ */
/* Route optimisation for the live fleet                               */
/* ------------------------------------------------------------------ */
async function currentRoutes() {
  const rider = await prisma.rider.findFirst({ where: { available: true }, orderBy: { updatedAt: 'desc' } });
  const orders = await prisma.order.findMany({
    where: {
      status: { notIn: ['DELIVERED', 'CANCELLED'] },
      // this rider's jobs + open marketplace jobs (not other riders' jobs)
      OR: [{ riderId: rider?.id ?? '__none__' }, { riderId: null, status: 'PENDING' }],
    },
    orderBy: { createdAt: 'asc' },
  });

  const empty = {
    orders, rider, routeReady: false, optimized: [], fifo: [], optimizedGeometry: [], fifoGeometry: [],
    optimizedDistance: 0, fifoDistance: 0, optimizedDuration: 0, fifoDuration: 0,
    distanceSavedKm: 0, distanceSavedPercent: 0,
  };
  if (!rider || rider.latitude === null || rider.longitude === null || orders.length === 0) return empty;

  const start: Point = { id: 'rider-start', lat: rider.latitude, lng: rider.longitude, kind: 'pickup', orderId: 'rider-start' };
  const stops = orderPoints(orders);
  const all = [start, ...stops];
  const matrix = await tableMatrix(all); // fetched ONCE and shared by both algorithms
  const [optimized, fifo] = await Promise.all([optimizeStops(start, stops, { matrix }), fifoRoute(start, stops, { matrix })]);
  const [optimizedGeometry, fifoGeometry] = await Promise.all([
    getRoadRoute([start, ...optimized.sequence]),
    getRoadRoute([start, ...fifo.sequence]),
  ]);
  const saved = fifo.distanceKm - optimized.distanceKm;
  return {
    orders, rider, routeReady: true,
    optimized: optimized.sequence, fifo: fifo.sequence, optimizedGeometry, fifoGeometry,
    optimizedDistance: optimized.distanceKm, fifoDistance: fifo.distanceKm,
    optimizedDuration: optimized.durationMinutes, fifoDuration: fifo.durationMinutes,
    distanceSavedKm: saved, distanceSavedPercent: fifo.distanceKm > 0 ? (saved / fifo.distanceKm) * 100 : 0,
    matrixSource: matrix.source,
  };
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */
app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: 'SmartRoute API', database: 'connected', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, service: 'SmartRoute API', database: 'disconnected' });
  }
});

/* ------------------------------------------------------------------ */
/* Customer orders                                                     */
/* ------------------------------------------------------------------ */
const OrderBody = z.object({
  pickupLat: z.number().min(-90).max(90), pickupLng: z.number().min(-180).max(180),
  dropLat: z.number().min(-90).max(90), dropLng: z.number().min(-180).max(180),
  priority: z.string().optional(),
  pickupName: z.string().max(100).optional(), pickupAddress: z.string().max(300).optional(),
  dropName: z.string().max(100).optional(), dropAddress: z.string().max(300).optional(),
  itemDescription: z.string().max(200).optional(), customerName: z.string().max(100).optional(),
}).passthrough();

const clean = (v: unknown, fallback: string, max = 200) =>
  (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback);

app.post('/api/orders', writeLimiter, async (req, res, next) => {
  try {
    const parsed = OrderBody.safeParse(req.body ?? {});
    if (!parsed.success) return apiError(res, 400, 'Valid pickup and drop coordinates are required.');
    const b = parsed.data;
    if (haversineKm({ lat: b.pickupLat, lng: b.pickupLng }, { lat: b.dropLat, lng: b.dropLng }) < 0.05) {
      return apiError(res, 400, 'Pickup and drop-off are too close together.');
    }
    const priority = b.priority?.toUpperCase() === 'EXPRESS' ? 'EXPRESS' : 'STANDARD';
    const q = quote({ lat: b.pickupLat, lng: b.pickupLng }, { lat: b.dropLat, lng: b.dropLng }, priority);

    const order = await prisma.$transaction(async (tx) => {
      const guest = await tx.user.create({
        data: {
          name: clean(b.customerName, 'Guest Customer', 100),
          email: `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@smartroute.local`,
          passwordHash: null, role: 'CUSTOMER',
        },
      });
      const created = await tx.order.create({
        data: {
          itemDescription: clean(b.itemDescription, 'Package'), priority, status: 'PENDING',
          pickupName: clean(b.pickupName, 'Pickup', 100), pickupAddress: clean(b.pickupAddress, 'Map location', 300),
          pickupLat: b.pickupLat, pickupLng: b.pickupLng,
          dropName: clean(b.dropName, 'Drop-off', 100), dropAddress: clean(b.dropAddress, 'Map location', 300),
          dropLat: b.dropLat, dropLng: b.dropLng,
          roadDistanceKm: q.roadKm, etaMinutes: q.etaMinutes, fare: q.fare,
          customerId: guest.id, riderId: null,
        },
      });
      await tx.deliveryEvent.create({ data: { orderId: created.id, status: 'PENDING', description: 'Order created', actor: 'CUSTOMER_DEMO' } });
      return created;
    });
    schedulePush();
    res.status(201).json(order);
  } catch (e) { next(e); }
});

app.get('/api/orders/my', async (_req, res, next) => {
  try {
    res.json(await prisma.order.findMany({ include: orderInclude, orderBy: { createdAt: 'desc' }, take: 200 }));
  } catch (e) { next(e); }
});

app.get('/api/orders/:id/events', async (req, res, next) => {
  try {
    res.json(await prisma.deliveryEvent.findMany({ where: { orderId: String(req.params.id) }, orderBy: { createdAt: 'asc' } }));
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Rider (demo mode: single shared rider, no auth)                     */
/* ------------------------------------------------------------------ */
app.get('/api/rider/profile', async (_req, res, next) => { try { res.json(await getDemoRider()); } catch (e) { next(e); } });

app.patch('/api/rider/availability', writeLimiter, async (req, res, next) => {
  try {
    if (typeof req.body?.available !== 'boolean') return apiError(res, 400, 'Availability must be true or false.');
    const demo = await getDemoRider();
    const rider = await prisma.rider.update({ where: { id: demo.id }, data: { available: req.body.available } });
    io.emit('rider:availability', rider);
    schedulePush();
    res.json(rider);
  } catch (e) { next(e); }
});

app.get('/api/rider/orders', async (_req, res, next) => {
  try {
    const rider = await getDemoRider();
    res.json(await prisma.order.findMany({
      where: { OR: [{ riderId: rider.id }, { riderId: null, status: 'PENDING' }] },
      include: orderInclude, orderBy: { createdAt: 'asc' }, take: 200,
    }));
  } catch (e) { next(e); }
});

app.post('/api/rider/orders/:id/accept', writeLimiter, async (req, res, next) => {
  try {
    const rider = await getDemoRider();
    const orderId = String(req.params.id);
    const n = await prisma.$transaction(async (tx) => {
      const r = await tx.order.updateMany({
        where: { id: orderId, riderId: null, status: 'PENDING' },
        data: { riderId: rider.id, status: 'ACCEPTED', acceptedAt: new Date() },
      });
      if (r.count === 0) return 0;
      await tx.deliveryEvent.create({ data: { orderId, status: 'ACCEPTED', description: 'Order accepted by demo rider', actor: 'RIDER_DEMO' } });
      return r.count;
    });
    if (n === 0) return apiError(res, 409, 'This order is no longer available.');
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
    schedulePush();
    io.emit('order:accepted', order);
    res.json(order);
  } catch (e) { next(e); }
});

app.patch('/api/rider/orders/:id/status', writeLimiter, async (req, res, next) => {
  try {
    const rider = await getDemoRider();
    const orderId = String(req.params.id);
    const next_ = req.body?.status as OrderStatus;
    if (!ORDER_STATUSES.includes(next_)) return apiError(res, 400, 'Invalid order status.');
    if (!['PICKED_UP', 'IN_TRANSIT', 'DELIVERED'].includes(next_)) return apiError(res, 400, 'Riders cannot set this status.');
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.riderId !== rider.id) return apiError(res, 404, 'Order not found for this rider.');
    const allowed: Record<string, string[]> = { ACCEPTED: ['PICKED_UP'], PICKED_UP: ['IN_TRANSIT'], IN_TRANSIT: ['DELIVERED'] };
    if (!(allowed[order.status] || []).includes(next_)) return apiError(res, 409, `Cannot move order from ${order.status} to ${next_}.`);
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.order.update({ where: { id: order.id }, data: { status: next_, ...statusTimestamps(next_) } });
      await tx.deliveryEvent.create({
        data: { orderId: order.id, status: next_, description: `Order status changed to ${next_}`, actor: 'RIDER_DEMO', latitude: rider.latitude ?? null, longitude: rider.longitude ?? null },
      });
      return u;
    });
    schedulePush();
    io.emit('order:status', updated);
    res.json(updated);
  } catch (e) { next(e); }
});

app.patch('/api/rider/location', rateLimit({ windowMs: 60_000, limit: 120 }), async (req, res, next) => {
  try {
    const { latitude, longitude, heading } = req.body ?? {};
    if (!validCoordinate(latitude, longitude)) return apiError(res, 400, 'Valid latitude and longitude are required.');
    if (heading !== undefined && heading !== null && (!isFiniteNumber(heading) || heading < 0 || heading >= 360)) {
      return apiError(res, 400, 'Heading must be between 0 and 359.');
    }
    const demo = await getDemoRider();
    const rider = await prisma.rider.update({
      where: { id: demo.id },
      data: { latitude, longitude, available: true, ...(isFiniteNumber(heading) ? { heading } : {}), lastSeen: new Date() },
    });
    io.emit('rider:location', { id: rider.id, latitude, longitude, heading: rider.heading });
    schedulePush();
    res.json(rider);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Admin (demo: unauthenticated — see README "production hardening")   */
/* ------------------------------------------------------------------ */
app.get('/api/admin/metrics', async (_req, res, next) => {
  try {
    const [totalOrders, pendingOrders, activeOrders, deliveredOrders, totalCustomers, totalRiders, availableRiders] = await Promise.all([
      prisma.order.count(),
      prisma.order.count({ where: { status: 'PENDING' } }),
      prisma.order.count({ where: { status: { in: ['ACCEPTED', 'PICKED_UP', 'IN_TRANSIT'] } } }),
      prisma.order.count({ where: { status: 'DELIVERED' } }),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.user.count({ where: { role: 'RIDER' } }),
      prisma.rider.count({ where: { available: true } }),
    ]);
    res.json({ totalOrders, pendingOrders, activeOrders, deliveredOrders, totalCustomers, totalRiders, availableRiders });
  } catch (e) { next(e); }
});

app.get('/api/admin/orders', async (_req, res, next) => {
  try { res.json(await prisma.order.findMany({ include: orderInclude, orderBy: { createdAt: 'desc' }, take: 500 })); } catch (e) { next(e); }
});

app.get('/api/admin/riders', async (_req, res, next) => {
  try {
    res.json(await prisma.rider.findMany({
      include: { user: publicUser, orders: { select: { id: true, status: true } } },
      orderBy: { updatedAt: 'desc' },
    }));
  } catch (e) { next(e); }
});

app.get('/api/routes', async (_req, res, next) => { try { res.json(await currentRoutes()); } catch (e) { next(e); } });

/* ------------------------------------------------------------------ */
/* Research benchmark                                                  */
/*   POST { size: 10|25|50, trials?: 1..30, seed?: int,                */
/*          matrix?: "haversine" | "osrm" }                            */
/*   - every trial uses an independent seed (seed + t)                 */
/*   - FIFO / Optimised / Exact(if <=7 orders) share ONE matrix        */
/*   - returns mean, sd, 95% CI, paired t-test                         */
/* ------------------------------------------------------------------ */
const BenchBody = z.object({
  size: z.number().int().refine((v) => [5, 7, 10, 25, 50].includes(v), 'Batch size must be 5, 7, 10, 25 or 50.'),
  trials: z.number().int().min(1).max(30).optional(),
  seed: z.number().int().min(0).max(2 ** 31).optional(),
  matrix: z.enum(['haversine', 'osrm']).optional(),
});

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function syntheticStops(seed: number, size: number): Point[] {
  const r = lcg(seed);
  return Array.from({ length: size }, (_, i) => {
    const priority = r() < 0.2 ? ('EXPRESS' as const) : ('STANDARD' as const);
    const mk = (kind: 'pickup' | 'drop'): Point => ({
      id: `b${seed}-${i}-${kind[0]}`, orderId: `b${seed}-${i}`, kind, priority,
      lat: 28.48 + r() * 0.22, lng: 77.28 + r() * 0.24,
    });
    const p = mk('pickup');
    const d = mk('drop');
    return [p, d];
  }).flat();
}

app.post('/api/benchmark', heavyLimiter, async (req, res, next) => {
  try {
    const parsed = BenchBody.safeParse({ ...req.body, size: Number(req.body?.size), trials: req.body?.trials === undefined ? undefined : Number(req.body.trials), seed: req.body?.seed === undefined ? undefined : Number(req.body.seed) });
    if (!parsed.success) return apiError(res, 400, parsed.error.issues[0]?.message || 'Invalid benchmark request.');
    const { size } = parsed.data;
    const trials = parsed.data.trials ?? 1;
    const baseSeed = parsed.data.seed ?? Math.floor(Math.random() * 1_000_000);
    const useOsrm = (parsed.data.matrix ?? (trials === 1 ? 'osrm' : 'haversine')) === 'osrm';
    if (useOsrm && trials > 3) return apiError(res, 400, 'Use matrix "haversine" for more than 3 trials (public OSRM is rate limited).');

    const start: Point = { id: 'benchmark-start', lat: center.lat, lng: center.lng, kind: 'pickup', orderId: 'benchmark-start' };
    const experimentId = `exp-${Date.now()}-${baseSeed}`;
    const rows: any[] = [];
    const perTrial: any[] = [];
    let matrixSource = 'HAVERSINE_FALLBACK';

    for (let t = 0; t < trials; t++) {
      const seed = baseSeed + t;
      const stops = syntheticStops(seed, size);
      const all = [start, ...stops];
      const matrix = await tableMatrix(all, !useOsrm); // one matrix => fair comparison, network time excluded
      matrixSource = matrix.source;

      const time = async <T,>(fn: () => Promise<T>) => { const t0 = performance.now(); const v = await fn(); return [v, performance.now() - t0] as const; };
      const [fifo, fifoMs] = await time(() => fifoRoute(start, stops, { matrix }));
      const [opt, optMs] = await time(() => optimizeStops(start, stops, { matrix }));
      const exact = size <= 7 ? await exactStops(start, stops, { matrix }) : null;

      const base = { experimentId, seed, batchSize: size, orderCount: size };
      rows.push({ ...base, algorithm: 'FIFO', distanceKm: fifo.distanceKm, durationMinutes: fifo.durationMinutes, computeMs: fifoMs });
      rows.push({ ...base, algorithm: 'OPTIMIZED', distanceKm: opt.distanceKm, durationMinutes: opt.durationMinutes, computeMs: optMs,
        improvementPct: fifo.distanceKm > 0 ? ((fifo.distanceKm - opt.distanceKm) / fifo.distanceKm) * 100 : 0 });
      if (exact) rows.push({ ...base, algorithm: 'EXACT', distanceKm: exact.distanceKm, durationMinutes: exact.durationMinutes, computeMs: 0, notes: 'Held-Karp optimum' });

      perTrial.push({
        seed, fifoKm: fifo.distanceKm, optKm: opt.distanceKm, exactKm: exact?.distanceKm ?? null,
        fifoMin: fifo.durationMinutes, optMin: opt.durationMinutes, optMs,
        savedPct: fifo.distanceKm > 0 ? ((fifo.distanceKm - opt.distanceKm) / fifo.distanceKm) * 100 : 0,
        gapToOptimalPct: exact ? ((opt.distanceKm - exact.distanceKm) / exact.distanceKm) * 100 : null,
      });
    }
    await prisma.benchmarkLog.createMany({ data: rows });

    const fifoKm = perTrial.map((r) => r.fifoKm);
    const optKm = perTrial.map((r) => r.optKm);
    const gaps = perTrial.map((r) => r.gapToOptimalPct).filter((v): v is number => v !== null);
    const first = rows.filter((r) => r.seed === baseSeed);
    const f0 = perTrial[0];
    res.json({
      experimentId, seed: baseSeed, batchSize: size, trials, matrixSource,
      // backward compatible with the old single-trial response
      results: first,
      comparison: {
        distanceSavedKm: f0.fifoKm - f0.optKm,
        distanceSavedPercent: f0.savedPct,
        durationSavedMinutes: f0.fifoMin - f0.optMin,
        durationSavedPercent: f0.fifoMin > 0 ? ((f0.fifoMin - f0.optMin) / f0.fifoMin) * 100 : 0,
      },
      summary: {
        distanceSavedPct: summarize(perTrial.map((r) => r.savedPct)),
        fifoKm: summarize(fifoKm),
        optimizedKm: summarize(optKm),
        optimizedComputeMs: summarize(perTrial.map((r) => r.optMs)),
        optimalityGapPct: gaps.length ? summarize(gaps) : null,
        pairedTTest: trials > 1 ? pairedT(fifoKm, optKm) : null,
      },
      perTrial,
    });
  } catch (e) { next(e); }
});

app.get('/api/benchmark', async (_req, res, next) => {
  try { res.json(await prisma.benchmarkLog.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 })); } catch (e) { next(e); }
});

app.get('/api/benchmark.csv', async (_req, res, next) => {
  try {
    const logs = await prisma.benchmarkLog.findMany({ orderBy: { createdAt: 'asc' } });
    const keys = ['experimentId', 'seed', 'batchSize', 'algorithm', 'distanceKm', 'durationMinutes', 'computeMs', 'improvementPct', 'createdAt'];
    // CSV-injection safe: neutralise cells that start with = + - @
    const cell = (v: unknown) => { let t = String(v ?? ''); if (/^[=+\-@]/.test(t) && Number.isNaN(Number(t))) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
    const csv = [keys.join(','), ...logs.map((r) => keys.map((k) => cell((r as any)[k])).join(','))].join('\n');
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', 'attachment; filename="smartroute-benchmarks.csv"');
    res.send(csv);
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Geocoding proxy (cached, rate-limited, proper User-Agent)           */
/* ------------------------------------------------------------------ */
const NOMINATIM = () => (process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const UA = () => process.env.NOMINATIM_USER_AGENT || 'SmartRouteCapstone/2.0 (student project)';
const geoCache = new Map<string, { at: number; data: unknown }>();
const GEO_TTL = 60 * 60 * 1000;
async function cachedFetch(key: string, url: string) {
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit.data;
  const r = await fetch(url, { headers: { 'User-Agent': UA(), 'Accept-Language': 'en' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Object.assign(new Error('geocoder'), { status: 502 });
  const data = await r.json();
  if (geoCache.size > 500) geoCache.delete(geoCache.keys().next().value as string);
  geoCache.set(key, { at: Date.now(), data });
  return data;
}

app.get('/api/geocode', geoLimiter, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 3) return res.json([]);
    if (q.length > 200) return apiError(res, 400, 'Search query is too long.');
    res.json(await cachedFetch(`s:${q.toLowerCase()}`, `${NOMINATIM()}/search?format=jsonv2&limit=5&countrycodes=in&q=${encodeURIComponent(q)}`));
  } catch (e: any) { e?.status === 502 ? apiError(res, 502, 'Geocoding service returned an error.') : next(e); }
});

app.get('/api/reverse', geoLimiter, async (req, res, next) => {
  try {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!validCoordinate(lat, lng)) return apiError(res, 400, 'Valid lat and lng are required.');
    res.json(await cachedFetch(`r:${lat.toFixed(4)},${lng.toFixed(4)}`, `${NOMINATIM()}/reverse?format=jsonv2&lat=${lat}&lon=${lng}`));
  } catch (e: any) { e?.status === 502 ? apiError(res, 502, 'Geocoding service returned an error.') : next(e); }
});

/* ------------------------------------------------------------------ */
/* Socket.io                                                           */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => socket.emit('connection:ready', { id: socket.id }));

/* ------------------------------------------------------------------ */
/* Errors + lifecycle                                                  */
/* ------------------------------------------------------------------ */
app.use('/api', (_req, res) => apiError(res, 404, 'Not found.'));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.message?.includes('not allowed by CORS')) return apiError(res, 403, 'Origin not allowed.');
  console.error('SmartRoute API error:', err);
  if (!res.headersSent) apiError(res, 500, 'Internal server error.');
});

const port = Number(process.env.PORT || 4000);
async function boot() {
  try { await prisma.$connect(); console.log('SmartRoute database connected.'); }
  catch (e) { console.error('Database connection failed:', e); }
  server.listen(port, () => console.log(`SmartRoute server listening on port ${port}`));
}
boot();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { server.close(async () => { await prisma.$disconnect(); process.exit(0); }); });
}
