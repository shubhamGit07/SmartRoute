import 'dotenv/config';

import express, { Request, Response, NextFunction } from 'express';

import cors from 'cors';

import http from 'http';

import { Server } from 'socket.io';

import { prisma } from './db.js';

import { optimizeStops, fifoRoute, getRoadRoute, Point } from './optimizer.js';

const app = express();

const server = http.createServer(app);

const allowedOrigins = process.env.CLIENT_URL

  ? process.env.CLIENT_URL.split(',').map((s) => s.trim())

  : ['http://localhost:5173'];

const io = new Server(server, {

  cors: {

    origin: allowedOrigins,

    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],

  },

});

app.use(cors({ origin: allowedOrigins }));

app.use(express.json({ limit: '1mb' }));

const center = { lat: 28.5355, lng: 77.3910 };

const ORDER_STATUSES = [

  'PENDING',

  'ACCEPTED',

  'PICKED_UP',

  'IN_TRANSIT',

  'DELIVERED',

  'CANCELLED',

] as const;

type OrderStatus = typeof ORDER_STATUSES[number];

// -----------------------------------------------------------------------------

// HELPERS

// -----------------------------------------------------------------------------

const isFiniteNumber = (value: unknown): value is number =>

  typeof value === 'number' && Number.isFinite(value);

function validCoordinate(lat: unknown, lng: unknown): boolean {

  return (

    isFiniteNumber(lat) &&

    isFiniteNumber(lng) &&

    lat >= -90 &&

    lat <= 90 &&

    lng >= -180 &&

    lng <= 180

  );

}

function apiError(res: Response, status: number, message: string) {

  return res.status(status).json({ error: message });

}

// DEMO MODE: create/reuse one rider without authentication.

async function getDemoRider() {

  const existing = await prisma.rider.findFirst({ where: { user: { email: 'demo-rider@smartroute.local' } }, include: { user: true } });

  if (existing) return existing;

  const user = await prisma.user.create({

    data: {

      name: 'Demo Rider',

      email: 'demo-rider@smartroute.local',

      passwordHash: 'demo-no-auth',

      role: 'RIDER',

      riderProfile: { create: { available: true } },

    },

    include: { riderProfile: { include: { user: true } } },

  });

  return user.riderProfile;

}

function cleanString(value: unknown, maxLength = 200): string | null {

  if (typeof value !== 'string') return null;

  const cleaned = value.trim();

  if (!cleaned) return null;

  return cleaned.slice(0, maxLength);

}

function getStatusTimestamps(status: OrderStatus) {

  const now = new Date();

  switch (status) {

    case 'ACCEPTED':

      return { acceptedAt: now };

    case 'PICKED_UP':

      return { pickedUpAt: now };

    case 'DELIVERED':

      return { deliveredAt: now };

    case 'CANCELLED':

      return { cancelledAt: now };

    default:

      return {};

  }

}

const orderPoints = (orders: any[]): Point[] =>

  orders.flatMap((order) => [

    {

      id: `p-${order.id}`,

      lat: order.pickupLat,

      lng: order.pickupLng,

      kind: 'pickup' as const,

      orderId: order.id,

      priority: order.priority,

    },

    {

      id: `d-${order.id}`,

      lat: order.dropLat,

      lng: order.dropLng,

      kind: 'drop' as const,

      orderId: order.id,

      priority: order.priority,

    },

  ]);

async function emitOrdersUpdate() {

  const orders = await prisma.order.findMany({

    include: {

      rider: {

        include: {

          user: true,

        },

      },

      customer: true,

    },

    orderBy: { createdAt: 'asc' },

  });

  io.emit('orders:update', orders);

}

async function emitRoutesUpdate() {

  io.emit('routes:update', await currentRoutes());

}

// -----------------------------------------------------------------------------

// ROUTE OPTIMIZATION

// -----------------------------------------------------------------------------

async function currentRoutes() {

  const rider = await prisma.rider.findFirst({

    where: {

      available: true,

    },

    orderBy: {

      updatedAt: 'desc',

    },

  });

  const orders = await prisma.order.findMany({

    where: {

      status: {

        notIn: ['DELIVERED', 'CANCELLED'],

      },

    },

    orderBy: {

      createdAt: 'asc',

    },

  });

  if (

    !rider ||

    rider.latitude === null ||

    rider.longitude === null ||

    orders.length === 0

  ) {

    return {

      orders,

      rider,

      routeReady: false,

      optimized: [],

      fifo: [],

      optimizedGeometry: [],

      fifoGeometry: [],

      optimizedDistance: 0,

      fifoDistance: 0,

      optimizedDuration: 0,

      fifoDuration: 0,

      distanceSavedKm: 0,

      distanceSavedPercent: 0,

    };

  }

  const start: Point = {

    id: 'rider-start',

    lat: rider.latitude,

    lng: rider.longitude,

    kind: 'pickup',

    orderId: 'rider-start',

  };

  const stops = orderPoints(orders);

  const [optimized, fifo] = await Promise.all([

    optimizeStops(start, stops),

    fifoRoute(start, stops),

  ]);

  const [optimizedGeometry, fifoGeometry] = await Promise.all([

    getRoadRoute([start, ...optimized.sequence]),

    getRoadRoute([start, ...fifo.sequence]),

  ]);

  const distanceSavedKm = fifo.distanceKm - optimized.distanceKm;

  const distanceSavedPercent =

    fifo.distanceKm > 0

      ? (distanceSavedKm / fifo.distanceKm) * 100

      : 0;

  return {

    orders,

    rider,

    routeReady: true,

    optimized: optimized.sequence,

    fifo: fifo.sequence,

    optimizedGeometry,

    fifoGeometry,

    optimizedDistance: optimized.distanceKm,

    fifoDistance: fifo.distanceKm,

    optimizedDuration: optimized.durationMinutes,

    fifoDuration: fifo.durationMinutes,

    distanceSavedKm,

    distanceSavedPercent,

    matrixSource: optimized.matrix.source,

  };

}

// -----------------------------------------------------------------------------

// HEALTH

// -----------------------------------------------------------------------------

app.get('/api/health', async (_req, res) => {

  try {

    await prisma.$queryRaw`SELECT 1`;

    res.json({

      ok: true,

      service: 'SmartRoute API',

      database: 'connected',

      time: new Date().toISOString(),

    });

  } catch {

    res.status(503).json({

      ok: false,

      service: 'SmartRoute API',

      database: 'disconnected',

    });

  }

});

// -----------------------------------------------------------------------------

// CUSTOMER ORDERS

// -----------------------------------------------------------------------------

app.post('/api/orders', async (req, res, next) => {

  try {

    const b = req.body ?? {};

    if (!validCoordinate(b.pickupLat, b.pickupLng) || !validCoordinate(b.dropLat, b.dropLng)) {

      return apiError(res, 400, 'Valid pickup and drop coordinates are required.');

    }

    const priority = b.priority === 'EXPRESS' ? 'EXPRESS' : 'STANDARD';

    const pickupName = cleanString(b.pickupName, 100) || 'Pickup';

    const pickupAddress = cleanString(b.pickupAddress, 300) || 'Map location';

    const dropName = cleanString(b.dropName, 100) || 'Drop-off';

    const dropAddress = cleanString(b.dropAddress, 300) || 'Map location';

    const itemDescription = cleanString(b.itemDescription, 200) || 'Package';

    const straightKm = Math.hypot((b.pickupLng - b.dropLng) * 85, (b.pickupLat - b.dropLat) * 111);

    const estimatedRoadKm = straightKm * 1.25;

    const fare = Math.round((35 + estimatedRoadKm * 10 + (priority === 'EXPRESS' ? 25 : 0)) * 100) / 100;

    const etaMinutes = Math.max(10, Math.round((estimatedRoadKm / 22) * 60));

    // Create a guest customer so required Prisma relations remain intact.

    const order = await prisma.$transaction(async (tx) => {

      const guestCustomer = await tx.user.create({

        data: {

          name: cleanString(b.customerName, 100) || 'Guest Customer',

          email: `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@smartroute.local`,

          passwordHash: 'guest-no-auth',

          role: 'CUSTOMER',

        },

      });

      const createdOrder = await tx.order.create({

        data: {

          itemDescription, priority, status: 'PENDING', pickupName, pickupAddress,

          pickupLat: b.pickupLat, pickupLng: b.pickupLng, dropName, dropAddress,

          dropLat: b.dropLat, dropLng: b.dropLng, roadDistanceKm: estimatedRoadKm,

          etaMinutes, fare, customerId: guestCustomer.id, riderId: null,

        },

      });

      await tx.deliveryEvent.create({

        data: { orderId: createdOrder.id, status: 'PENDING', description: 'Order created', actor: 'CUSTOMER_DEMO' },

      });

      return createdOrder;

    });

    await emitOrdersUpdate();

    await emitRoutesUpdate();

    res.status(201).json(order);

  } catch (e) { next(e); }

});

app.get('/api/orders/my', async (req, res, next) => {

  try {

    const orders = await prisma.order.findMany({

      include: { rider: { include: { user: true } }, customer: true },

      orderBy: { createdAt: 'desc' },

    });

    res.json(orders);

  } catch (e) { next(e); }

});

app.get('/api/orders/:id/events', async (req, res, next) => {

  try {

    const events = await prisma.deliveryEvent.findMany({

      where: { orderId: String(req.params.id) },

      orderBy: { createdAt: 'asc' },

    });

    res.json(events);

  } catch (e) { next(e); }

});

// -----------------------------------------------------------------------------

// RIDER

// -----------------------------------------------------------------------------

app.get('/api/rider/profile', async (req, res, next) => {

  try { res.json(await getDemoRider()); } catch (e) { next(e); }

});

app.patch('/api/rider/availability', async (req, res, next) => {

  try {

    if (typeof req.body?.available !== 'boolean') return apiError(res, 400, 'Availability must be true or false.');

    const demoRider = await getDemoRider();

    const rider = await prisma.rider.update({ where: { id: demoRider.id }, data: { available: req.body.available } });

    io.emit('rider:availability', rider);

    res.json(rider);

  } catch (e) { next(e); }

});

app.get('/api/rider/orders', async (req, res, next) => {

  try {

    const rider = await getDemoRider();

    const orders = await prisma.order.findMany({

      where: { OR: [{ riderId: rider.id }, { riderId: null, status: 'PENDING' }] },

      include: { customer: true, rider: { include: { user: true } } },

      orderBy: { createdAt: 'asc' },

    });

    res.json(orders);

  } catch (e) { next(e); }

});

app.post('/api/rider/orders/:id/accept', async (req, res, next) => {

  try {

    const rider = await getDemoRider();

    const orderId = String(req.params.id);

    const result = await prisma.$transaction(async (tx) => {

      const updatedCount = await tx.order.updateMany({

        where: { id: orderId, riderId: null, status: 'PENDING' },

        data: { riderId: rider.id, status: 'ACCEPTED', acceptedAt: new Date() },

      });

      if (updatedCount.count === 0) return 0;

      await tx.deliveryEvent.create({

        data: { orderId, status: 'ACCEPTED', description: 'Order accepted by demo rider', actor: 'RIDER_DEMO' },

      });

      return updatedCount.count;

    });

    if (result === 0) return apiError(res, 409, 'This order is no longer available.');

    const order = await prisma.order.findUnique({

      where: { id: orderId }, include: { customer: true, rider: { include: { user: true } } },

    });

    await emitOrdersUpdate();

    await emitRoutesUpdate();

    io.emit('order:accepted', order);

    res.json(order);

  } catch (e) { next(e); }

});

app.patch('/api/rider/orders/:id/status', async (req, res, next) => {

  try {

    const rider = await getDemoRider();

    const orderId = String(req.params.id);

    const nextStatus = req.body?.status as OrderStatus;

    if (!ORDER_STATUSES.includes(nextStatus)) return apiError(res, 400, 'Invalid order status.');

    if (!['PICKED_UP', 'IN_TRANSIT', 'DELIVERED'].includes(nextStatus)) return apiError(res, 400, 'Riders cannot set this status.');

    const order = await prisma.order.findUnique({ where: { id: orderId } });

    if (!order || order.riderId !== rider.id) return apiError(res, 404, 'Order not found for this rider.');

    const allowedTransitions: Record<string, string[]> = {

      ACCEPTED: ['PICKED_UP'], PICKED_UP: ['IN_TRANSIT'], IN_TRANSIT: ['DELIVERED'],

    };

    const allowed = allowedTransitions[order.status] || [];

    if (!allowed.includes(nextStatus)) return apiError(res, 409, `Cannot move order from ${order.status} to ${nextStatus}.`);

    const updated = await prisma.$transaction(async (tx) => {

      const updatedOrder = await tx.order.update({

        where: { id: order.id }, data: { status: nextStatus, ...getStatusTimestamps(nextStatus) },

      });

      await tx.deliveryEvent.create({

        data: { orderId: order.id, status: nextStatus, description: `Order status changed to ${nextStatus}`, actor: 'RIDER_DEMO' },

      });

      return updatedOrder;

    });

    await emitOrdersUpdate();

    await emitRoutesUpdate();

    io.emit('order:status', updated);

    res.json(updated);

  } catch (e) { next(e); }

});

app.patch('/api/rider/location', async (req, res, next) => {

  try {

    const { latitude, longitude, heading } = req.body ?? {};

    if (!validCoordinate(latitude, longitude)) return apiError(res, 400, 'Valid latitude and longitude are required.');

    if (heading !== undefined && (!isFiniteNumber(heading) || heading < 0 || heading >= 360)) return apiError(res, 400, 'Heading must be between 0 and 359.');

    const demoRider = await getDemoRider();

    const rider = await prisma.rider.update({

      where: { id: demoRider.id },

      data: { latitude, longitude, ...(heading !== undefined ? { heading } : {}), lastSeen: new Date() },

    });

    io.emit('rider:location', rider);

    await emitRoutesUpdate();

    res.json(rider);

  } catch (e) { next(e); }

});

// -----------------------------------------------------------------------------

app.get('/api/admin/metrics', async (_req, res, next) => {

  try {

    const [

      totalOrders,

      pendingOrders,

      activeOrders,

      deliveredOrders,

      totalCustomers,

      totalRiders,

      availableRiders,

    ] = await Promise.all([

      prisma.order.count(),

      prisma.order.count({ where: { status: 'PENDING' } }),

      prisma.order.count({

        where: {

          status: {

            in: ['ACCEPTED', 'PICKED_UP', 'IN_TRANSIT'],

          },

        },

      }),

      prisma.order.count({ where: { status: 'DELIVERED' } }),

      prisma.user.count({ where: { role: 'CUSTOMER' } }),

      prisma.user.count({ where: { role: 'RIDER' } }),

      prisma.rider.count({ where: { available: true } }),

    ]);

    res.json({

      totalOrders,

      pendingOrders,

      activeOrders,

      deliveredOrders,

      totalCustomers,

      totalRiders,

      availableRiders,

    });

  } catch (e) {

    next(e);

  }

});

app.get('/api/admin/orders', async (_req, res, next) => {

  try {

    const orders = await prisma.order.findMany({

      include: {

        customer: true,

        rider: {

          include: {

            user: true,

          },

        },

      },

      orderBy: {

        createdAt: 'desc',

      },

    });

    res.json(orders);

  } catch (e) {

    next(e);

  }

});

app.get('/api/admin/riders', async (_req, res, next) => {

  try {

    const riders = await prisma.rider.findMany({

      include: {

        user: true,

        orders: true,

      },

      orderBy: {

        updatedAt: 'desc',

      },

    });

    res.json(riders);

  } catch (e) {

    next(e);

  }

});

// -----------------------------------------------------------------------------

// ROUTE API

// -----------------------------------------------------------------------------

app.get('/api/routes', async (_req, res, next) => {

  try {

    res.json(await currentRoutes());

  } catch (e) {

    next(e);

  }

});

// -----------------------------------------------------------------------------

// RESEARCH BENCHMARK

// -----------------------------------------------------------------------------

app.post('/api/benchmark', async (req, res, next) => {

  try {

    const size = Number(req.body?.size);

    if (![10, 25, 50].includes(size)) {

      return apiError(res, 400, 'Batch size must be 10, 25 or 50.');

    }

    const requestedSeed = Number(req.body?.seed);

    const seed =

      Number.isInteger(requestedSeed) && requestedSeed >= 0

        ? requestedSeed

        : Math.floor(Math.random() * 1_000_000);

    let state = seed >>> 0;

    const random = () => {

      state = (state * 1664525 + 1013904223) >>> 0;

      return state / 4294967296;

    };

    const stops = Array.from({ length: size }, (_, i) => {

      const pickupLat = 28.48 + random() * 0.22;

      const pickupLng = 77.28 + random() * 0.24;

      const dropLat = 28.48 + random() * 0.22;

      const dropLng = 77.28 + random() * 0.24;

      const priority =

        random() < 0.2

          ? 'EXPRESS' as const

          : 'STANDARD' as const;

      return [

        {

          id: `b${seed}-${i}-p`,

          lat: pickupLat,

          lng: pickupLng,

          kind: 'pickup' as const,

          orderId: `b${seed}-${i}`,

          priority,

        },

        {

          id: `b${seed}-${i}-d`,

          lat: dropLat,

          lng: dropLng,

          kind: 'drop' as const,

          orderId: `b${seed}-${i}`,

          priority,

        },

      ];

    }).flat();

    const start: Point = {

      id: 'benchmark-start',

      lat: center.lat,

      lng: center.lng,

      kind: 'pickup',

      orderId: 'benchmark-start',

    };

    const experimentId = `exp-${Date.now()}-${seed}`;

    await fifoRoute(start, stops);

    const fifoStart = performance.now();

    const fifoResult = await fifoRoute(start, stops);

    const fifoComputeMs = performance.now() - fifoStart;

    const optimizedStart = performance.now();

    const optimizedResult = await optimizeStops(start, stops);

    const optimizedComputeMs = performance.now() - optimizedStart;

    const fifoRow = {

      experimentId,

      seed,

      batchSize: size,

      algorithm: 'FIFO',

      distanceKm: fifoResult.distanceKm,

      durationMinutes: fifoResult.durationMinutes,

      computeMs: fifoComputeMs,

    };

    const optimizedRow = {

      experimentId,

      seed,

      batchSize: size,

      algorithm: 'OPTIMIZED',

      distanceKm: optimizedResult.distanceKm,

      durationMinutes: optimizedResult.durationMinutes,

      computeMs: optimizedComputeMs,

    };

    await prisma.benchmarkLog.createMany({

      data: [fifoRow, optimizedRow],

    });

    const distanceSavedKm =

      fifoResult.distanceKm - optimizedResult.distanceKm;

    const distanceSavedPercent =

      fifoResult.distanceKm > 0

        ? (distanceSavedKm / fifoResult.distanceKm) * 100

        : 0;

    const durationSavedMinutes =

      fifoResult.durationMinutes - optimizedResult.durationMinutes;

    const durationSavedPercent =

      fifoResult.durationMinutes > 0

        ? (durationSavedMinutes / fifoResult.durationMinutes) * 100

        : 0;

    res.json({

      experimentId,

      seed,

      batchSize: size,

      matrixSource: optimizedResult.matrix.source,

      results: [fifoRow, optimizedRow],

      comparison: {

        distanceSavedKm,

        distanceSavedPercent,

        durationSavedMinutes,

        durationSavedPercent,

      },

    });

  } catch (e) {

    next(e);

  }

});

app.get('/api/benchmark', async (_req, res, next) => {

  try {

    res.json(

      await prisma.benchmarkLog.findMany({

        orderBy: { createdAt: 'desc' },

      })

    );

  } catch (e) {

    next(e);

  }

});

app.get('/api/benchmark.csv', async (_req, res, next) => {

  try {

    const logs = await prisma.benchmarkLog.findMany({

      orderBy: { createdAt: 'asc' },

    });

    const keys = [

      'experimentId',

      'seed',

      'batchSize',

      'algorithm',

      'distanceKm',

      'durationMinutes',

      'computeMs',

      'createdAt',

    ];

    const csvCell = (value: unknown) => {

      const text = String(value ?? '');

      return `"${text.replace(/"/g, '""')}"`;

    };

    const csv = [

      keys.join(','),

      ...logs.map((row) =>

        keys.map((key) => csvCell((row as any)[key])).join(',')

      ),

    ].join('\n');

    res.header('Content-Type', 'text/csv; charset=utf-8');

    res.header(

      'Content-Disposition',

      'attachment; filename="smartroute-benchmarks.csv"'

    );

    res.send(csv);

  } catch (e) {

    next(e);

  }

});

// -----------------------------------------------------------------------------

// GEOCODING

// -----------------------------------------------------------------------------

app.get('/api/geocode', async (req, res, next) => {

  try {

    const query = String(req.query.q ?? '').trim();

    if (query.length < 3) {

      return res.json([]);

    }

    if (query.length > 200) {

      return apiError(res, 400, 'Search query is too long.');

    }

    const base = (

      process.env.NOMINATIM_BASE ||

      'https://nominatim.openstreetmap.org'

    ).replace(/\/$/, '');

    const response = await fetch(

      `${base}/search?format=jsonv2&limit=5&countrycodes=in&q=${encodeURIComponent(query)}`,

      {

        headers: {

          'User-Agent':

            process.env.NOMINATIM_USER_AGENT ||

            'SmartRouteCapstone/1.0',

        },

        signal: AbortSignal.timeout(8000),

      }

    );

    if (!response.ok) {

      return apiError(res, 502, 'Geocoding service returned an error.');

    }

    res.json(await response.json());

  } catch (e) {

    next(e);

  }

});

// -----------------------------------------------------------------------------

// SOCKET.IO

// -----------------------------------------------------------------------------

io.on('connection', (socket) => {

  socket.emit('connection:ready', {

    id: socket.id,

  });

});

// -----------------------------------------------------------------------------

// ERROR HANDLER

// -----------------------------------------------------------------------------

app.use(

  (

    err: unknown,

    _req: Request,

    res: Response,

    _next: NextFunction

  ) => {

    console.error('SmartRoute API error:', err);

    if (res.headersSent) return;

    res.status(500).json({

      error: 'Internal server error.',

    });

  }

);

// -----------------------------------------------------------------------------

// SERVER START

// -----------------------------------------------------------------------------

const port = Number(process.env.PORT || 4000);

async function boot() {

  try {

    await prisma.$connect();

    console.log('SmartRoute database connected.');

  } catch (error) {

    console.error('Database connection failed:', error);

  }

  server.listen(port, () => {

    console.log(`SmartRoute server listening on port ${port}`);

  });

}

boot();
