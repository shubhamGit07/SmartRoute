import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import {
  Route,
  Package,
  Truck,
  LayoutDashboard,
  FlaskConical,
  MapPin,
  Search,
  X,
  Crosshair,
  Clock,
  Zap,
  RotateCcw,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Download,
  Play,
  Inbox,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
} from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { io } from "socket.io-client";
import "./styles.css";
/* =====================================================
   CONSTANTS & HELPERS
===================================================== */
const API_BASE = (import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "" : "http://localhost:4000")).replace(/\/+$/, "");
const DEFAULT_CENTER = [28.6139, 77.209];
const STATUS_FLOW = ["PENDING", "ACCEPTED", "PICKED_UP", "IN_TRANSIT", "DELIVERED"];
const NEXT_STATUS = {
  PENDING: "ACCEPTED",
  ACCEPTED: "PICKED_UP",
  PICKED_UP: "IN_TRANSIT",
  IN_TRANSIT: "DELIVERED",
};
const NEXT_ACTION = {
  PENDING: "Accept order",
  ACCEPTED: "Confirm pickup",
  PICKED_UP: "Start transit",
  IN_TRANSIT: "Mark as delivered",
};
const BASE_FARE = 35;
const PER_KM = 10;
const EXPRESS_FEE = 25;
const PAGE_SIZE = 8;
const statusLabel = (s) =>
  s ? s.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()) : "Unknown";
const shortId = (id) => (id ? `#${String(id).slice(0, 6)}` : "—");
const fmtKm = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? `${Number(v).toFixed(2)} km` : "—");
const fmtMs = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? `${Number(v).toFixed(1)} ms` : "—");
/* (fifo - optimized) / fifo * 100 */
const reductionPct = (fifo, opt) => {
  const f = Number(fifo);
  const o = Number(opt);
  if (!Number.isFinite(f) || !Number.isFinite(o) || f <= 0) return null;
  return ((f - o) / f) * 100;
};
const makeIcon = (kind, letter) =>
  new L.DivIcon({
    className: "",
    html: `<div class="pin-marker ${kind}">${letter}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
const pickupIcon = makeIcon("pickup", "P");
const dropIcon = makeIcon("drop", "D");
async function reverseGeocode(lat, lng) {
  const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  try {
    const res = await fetch(
      `${API_BASE}/api/reverse?lat=${lat}&lng=${lng}`
    );
    if (!res.ok) return fallback;
    const data = await res.json();
    return data.display_name || fallback;
  } catch {
    return fallback;
  }
}
/* =====================================================
   SHARED UI PIECES
===================================================== */
function StatusBadge({ status }) {
  const key = STATUS_FLOW.includes(status) ? status.toLowerCase() : "unknown";
  return <span className={`badge s-${key}`}>{statusLabel(status)}</span>;
}
function PriorityBadge({ priority }) {
  const p = String(priority || "standard").toLowerCase();
  return <span className={`badge plain ${p === "express" ? "express" : "standard"}`}>{p === "express" ? "Express" : "Standard"}</span>;
}
function Kpi({ label, value, hint, loading, good }) {
  return (
    <div className={`card kpi ${good ? "good" : ""}`}>
      <span>{label}</span>
      {loading ? <div className="skeleton" style={{ height: 30, width: "55%" }} /> : <strong>{value}</strong>}
      {hint && <small>{hint}</small>}
    </div>
  );
}
function Empty({ icon: Icon = Inbox, title, text, action }) {
  return (
    <div className="empty">
      <Icon size={34} />
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}
function ErrorBanner({ message, onRetry }) {
  if (!message) return null;
  return (
    <div className="alert err" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
function Toasts({ items }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          {t.type === "error" ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
function Modal({ title, onClose, children, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
/* keeps Leaflet correct when the layout resizes (mobile / sidebar / rotate) */
function MapSizer() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}
function OsmTiles() {
  return (
    <TileLayer
      attribution='&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a>'
      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
    />
  );
}
/* =====================================================
   DATA HOOK (rider + admin + research share one source)
===================================================== */
function useBackend(active) {
  const [orders, setOrders] = useState([]);
  const [riders, setRiders] = useState([]);
  const [routes, setRoutes] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      // Check server health separately from protected data endpoints.
      const health = await fetch(`${API_BASE}/api/health`);
      if (!health.ok) throw new Error("Health check failed");
      const healthData = await health.json();
      if (!healthData.ok) throw new Error("Backend/database health check failed");
      // Public demo APIs: shared data feed for Customer, Rider, Admin and Research.
      const [routesRes, historyRes, ordersRes, ridersRes, riderOrdersRes] = await Promise.all([
        fetch(`${API_BASE}/api/routes`),
        fetch(`${API_BASE}/api/benchmark`),
        fetch(`${API_BASE}/api/orders/my`),
        fetch(`${API_BASE}/api/admin/riders`),
        fetch(`${API_BASE}/api/rider/orders`),
      ]);
      const [routesData, historyData, ordersData, ridersData, riderOrdersData] = await Promise.all([
        routesRes.ok ? routesRes.json() : Promise.resolve(null),
        historyRes.ok ? historyRes.json() : Promise.resolve([]),
        ordersRes.ok ? ordersRes.json() : Promise.resolve([]),
        ridersRes.ok ? ridersRes.json() : Promise.resolve([]),
        riderOrdersRes.ok ? riderOrdersRes.json() : Promise.resolve([]),
      ]);
      // Merge both public order feeds by ID, then keep the newest orders first.
      const mergedOrders = new Map();
      [ordersData, riderOrdersData].forEach((list) => {
        if (Array.isArray(list)) list.forEach((order) => {
          if (order?.id) mergedOrders.set(order.id, { ...mergedOrders.get(order.id), ...order });
        });
      });
      setRoutes(routesData);
      setHistory(Array.isArray(historyData) ? historyData : []);
      setOrders([...mergedOrders.values()].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));
      setRiders(Array.isArray(ridersData) ? ridersData : []);
      const failed = [routesRes, historyRes, ordersRes, ridersRes, riderOrdersRes].filter((r) => !r.ok);
      if (failed.length) console.warn('Some SmartRoute endpoints returned errors:', failed.map((r) => r.status));
    } catch (e) {
      console.error(e);
      setError("The server may be waking up (free hosting sleeps when idle). Retrying…");
      setTimeout(() => load(true), 6000);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    load();
    // Socket.io pushes (debounced) -> instant UI; polling is only a slow safety net.
    let debounce;
    const refresh = () => { clearTimeout(debounce); debounce = setTimeout(() => load(true), 400); };
    const socket = io(API_BASE || undefined, { transports: ["websocket", "polling"], reconnectionDelayMax: 10000 });
    ["orders:update", "routes:update", "rider:location"].forEach((ev) => socket.on(ev, refresh));
    const t = setInterval(() => load(true), 30000);
    return () => { clearTimeout(debounce); clearInterval(t); socket.disconnect(); };
  }, [active, load]);
  return { orders, riders, routes, history, loading, loaded, error, load };
}
/* =====================================================
   CUSTOMER PORTAL
===================================================== */
function MapClicks({ mode, onPick }) {
  useMapEvents({ click: (e) => onPick(e.latlng, mode) });
  return null;
}
function FitView({ pickup, drop, route }) {
  const map = useMap();
  useEffect(() => {
    if (route?.coords?.length) {
      const b = L.latLngBounds(route.coords);
      if (b.isValid()) map.fitBounds(b, { padding: [50, 50], maxZoom: 15 });
    } else if (pickup && drop) {
      map.fitBounds(L.latLngBounds([[pickup.lat, pickup.lng], [drop.lat, drop.lng]]), { padding: [70, 70], maxZoom: 14 });
    } else if (pickup || drop) {
      const p = pickup || drop;
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 13));
    }
  }, [pickup, drop, route, map]);
  return null;
}
function CustomerPortal({ toast, onBooked }) {
  const [pickup, setPickup] = useState(null);
  const [drop, setDrop] = useState(null);
  const [mode, setMode] = useState("pickup");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [route, setRoute] = useState(null);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [routeTick, setRouteTick] = useState(0);
  const [item, setItem] = useState("Package");
  const [priority, setPriority] = useState("standard");
  const [touched, setTouched] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [booked, setBooked] = useState(null);
  /* ---- fare (same formula as before, itemised) ---- */
  const fare = useMemo(() => {
    if (!route || !pickup || !drop) return null;
    // Keep the displayed fare consistent with the backend order-creation formula:
    // straight-line distance × 1.25, then ₹10/km, ₹35 base, ₹25 express.
    const straightKm = Math.hypot(
      (pickup.lng - drop.lng) * 85,
      (pickup.lat - drop.lat) * 111
    );
    const estimatedRoadKm = straightKm * 1.25;
    const distanceCharge = estimatedRoadKm * PER_KM;
    const express = priority === "express" ? EXPRESS_FEE : 0;
    const total = Math.round((BASE_FARE + distanceCharge + express) * 100) / 100;
    return { base: BASE_FARE, distanceCharge, express, total, estimatedRoadKm };
  }, [route, pickup, drop, priority]);
  /* ---- location setters ---- */
  const setLocation = (m, loc) => {
    if (m === "pickup") setPickup(loc);
    else setDrop(loc);
    setResults([]);
    setQuery("");
    setBooked(null);
    if (m === "pickup" && !drop) setMode("drop");
  };
  async function pickOnMap(latlng, m) {
    const { lat, lng } = latlng;
    const provisional = { lat, lng, name: "Locating address…", address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
    setLocation(m, provisional);
    const address = await reverseGeocode(lat, lng);
    const next = { lat, lng, address, name: address.split(",")[0] || "Selected location" };
    const apply = (cur) => (cur && cur.lat === lat && cur.lng === lng ? next : cur);
    if (m === "pickup") setPickup(apply);
    else setDrop(apply);
  }
  async function search() {
    if (!query.trim()) {
      toast("Enter a place to search", "error");
      return;
    }
    setSearching(true);
    setResults([]);
    try {
      const res = await fetch(
        `${API_BASE}/api/geocode?q=${encodeURIComponent(query)}`
      );
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      if (!data.length) toast("No matching place found. Try a nearby landmark.", "error");
      setResults(data);
    } catch (e) {
      console.error(e);
      toast("Search is unavailable right now. Click the map instead.", "error");
    } finally {
      setSearching(false);
    }
  }
  function chooseResult(r) {
    setLocation(mode, {
      lat: Number(r.lat),
      lng: Number(r.lon),
      address: r.display_name,
      name: r.name || r.display_name.split(",")[0],
    });
    toast(mode === "pickup" ? "Pickup set" : "Drop-off set");
  }
  /* ---- route (auto when both points exist) ---- */
  useEffect(() => {
    setRouteError("");
    if (!pickup || !drop) {
      setRoute(null);
      return undefined;
    }
    if (pickup.lat === drop.lat && pickup.lng === drop.lng) {
      setRoute(null);
      setRouteError("Pickup and drop-off are the same point. Choose a different drop-off.");
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setRouting(true);
      try {
        const res = await fetch(
          `https://router.project-osrm.org/route/v1/driving/${pickup.lng},${pickup.lat};${drop.lng},${drop.lat}?overview=full&geometries=geojson`
        );
        if (!res.ok) throw new Error("Route request failed");
        const data = await res.json();
        const r = data.routes?.[0];
        if (!r) throw new Error("No route found");
        if (cancelled) return;
        setRoute({
          coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
          distance: r.distance / 1000,
          duration: r.duration / 60,
        });
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setRoute(null);
          setRouteError("Couldn't calculate a road route between these points.");
        }
      } finally {
        if (!cancelled) setRouting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickup?.lat, pickup?.lng, drop?.lat, drop?.lng, routeTick]);
  /* ---- validation ---- */
  const errors = {};
  if (!pickup) errors.pickup = "Choose a pickup location.";
  if (!drop) errors.drop = "Choose a drop-off location.";
  if (!item.trim()) errors.item = "Describe what is being delivered.";
  if (pickup && drop && !route && !routing && !routeError) errors.route = "Route is not ready yet.";
  const blocked = Object.keys(errors).length > 0 || !!routeError || routing;
  function tryBook() {
    setTouched(true);
    if (blocked) return;
    setConfirmOpen(true);
  }
  /* Adjust this payload if your POST /api/orders expects different field names. */
  const buildOrderPayload = () => ({
    pickupName: pickup.name,
    pickupAddress: pickup.address,
    pickupLat: pickup.lat,
    pickupLng: pickup.lng,
    dropName: drop.name,
    dropAddress: drop.address,
    dropLat: drop.lat,
    dropLng: drop.lng,
    itemDescription: item.trim(),
    priority: priority.toUpperCase(),
    fare: fare.total,
    distanceKm: Number(route.distance.toFixed(2)),
    etaMinutes: Math.round(route.duration),
  });
  async function confirmBooking() {
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildOrderPayload()),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Booking failed");
      setBooked(data);
      setConfirmOpen(false);
      toast("Order placed successfully");
      if (typeof onBooked === "function") await onBooked(data);
    } catch (e) {
      toast(e.message || "Couldn't place the order", "error");
    } finally {
      setSubmitting(false);
    }
  }
  function resetAll() {
    setPickup(null);
    setDrop(null);
    setRoute(null);
    setRouteError("");
    setQuery("");
    setResults([]);
    setPriority("standard");
    setItem("Package");
    setTouched(false);
    setBooked(null);
    setMode("pickup");
    setResetOpen(false);
    toast("Delivery cleared");
  }
  const Stop = ({ kind, loc, label, err }) => (
    <button
      type="button"
      className={`stop ${mode === kind ? "active" : ""} ${loc ? "" : "empty-stop"}`}
      onClick={() => setMode(kind)}
      aria-pressed={mode === kind}
    >
      <span className={`pin ${kind === "pickup" ? "p" : "d"}`}>{kind === "pickup" ? "P" : "D"}</span>
      <span className="stop-text">
        <small>{label}</small>
        <strong>{loc?.name || "Not selected"}</strong>
        <p>{loc?.address || (touched && err ? "" : "Search or click the map")}</p>
        {touched && err && <span className="field-error">{err}</span>}
      </span>
      {mode === kind && <span className="stop-state">Selecting</span>}
    </button>
  );
  return (
    <div className="cust">
      <aside className="cust-panel">
        {/* search */}
        <div className="field">
          <label htmlFor="loc-search">Find a place</label>
          <div className="search-row">
            <div className="input">
              <Search size={17} />
              <input
                id="loc-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder={`Search ${mode === "pickup" ? "pickup" : "drop-off"} in India`}
              />
              {query && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setQuery(""); setResults([]); }} aria-label="Clear search">
                  <X size={16} />
                </button>
              )}
            </div>
            <button className="btn btn-primary" onClick={search} disabled={searching}>
              {searching ? <Loader2 size={16} className="spin" /> : "Search"}
            </button>
          </div>
          {results.length > 0 && (
            <div className="results">
              {results.map((r) => (
                <button key={r.place_id} className="result" onClick={() => chooseResult(r)}>
                  <MapPin size={16} />
                  <div>
                    <strong>{r.name || r.display_name.split(",")[0]}</strong>
                    <span>{r.display_name}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* stops */}
        <div className="stops">
          <Stop kind="pickup" loc={pickup} label="Pickup" err={errors.pickup} />
          <Stop kind="drop" loc={drop} label="Drop-off" err={errors.drop} />
        </div>
        {/* package */}
        <div className="field">
          <label htmlFor="pkg">Package</label>
          <div className={`input ${touched && errors.item ? "invalid" : ""}`}>
            <Package size={17} />
            <input id="pkg" value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. Documents, groceries, parcel" maxLength={80} />
          </div>
          {touched && errors.item && <span className="field-error">{errors.item}</span>}
        </div>
        {/* priority */}
        <div className="field">
          <label>Delivery speed</label>
          <div className="seg">
            <button type="button" className={`seg-btn ${priority === "standard" ? "active" : ""}`} onClick={() => setPriority("standard")} aria-pressed={priority === "standard"}>
              <span className="t"><Clock size={16} /> Standard</span>
              <small>Regular delivery</small>
            </button>
            <button type="button" className={`seg-btn express ${priority === "express" ? "active" : ""}`} onClick={() => setPriority("express")} aria-pressed={priority === "express"}>
              <span className="t"><Zap size={16} /> Express</span>
              <small>Priority, +₹{EXPRESS_FEE}</small>
            </button>
          </div>
        </div>
        {/* estimate */}
        <div className="estimate" aria-live="polite">
          {routing ? (
            <>
              <div className="estimate-top">
                <div><span>Distance</span><div className="skeleton" style={{ height: 24, width: 70 }} /></div>
                <div><span>Est. time</span><div className="skeleton" style={{ height: 24, width: 70 }} /></div>
              </div>
              <div className="skeleton" style={{ height: 56 }} />
            </>
          ) : routeError ? (
            <>
              <div className="alert err"><AlertCircle size={17} /><span>{routeError}</span></div>
              {pickup && drop && !(pickup.lat === drop.lat && pickup.lng === drop.lng) && (
                <button className="btn btn-sm" onClick={() => setRouteTick((t) => t + 1)}><RefreshCw size={14} /> Try again</button>
              )}
            </>
          ) : route && fare ? (
            <>
              <div className="estimate-top num">
                <div><span>Distance</span><strong>{route.distance.toFixed(1)} km</strong></div>
                <div><span>Est. time</span><strong>{Math.round(route.duration)} min</strong></div>
              </div>
              <hr />
              <div className="summary-row num"><span>Base fare</span><strong>₹{fare.base}</strong></div>
              <div className="summary-row num"><span>Estimated road distance ({fare.estimatedRoadKm.toFixed(1)} km × ₹{PER_KM})</span><strong>₹{fare.distanceCharge}</strong></div>
              {fare.express > 0 && <div className="summary-row num"><span>Express fee</span><strong>₹{fare.express}</strong></div>}
              <div className="summary-row summary-total num"><span>Total</span><strong>₹{fare.total}</strong></div>
            </>
          ) : (
            <p className="note">Select pickup and drop-off to see distance, time and fare.</p>
          )}
        </div>
        {booked ? (
          <div className="success-card">
            <strong>Order placed</strong>
            <p className="note">Your delivery is in the queue. Track its status from the Rider and Orders views.</p>
            <button className="btn btn-block" onClick={resetAll}>Plan another delivery</button>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <button className="btn btn-primary btn-block" onClick={tryBook} disabled={routing}>
              <Route size={17} /> Review &amp; book
            </button>
            <button className="btn btn-block" onClick={() => (pickup || drop ? setResetOpen(true) : null)} disabled={!pickup && !drop}>
              <RotateCcw size={16} /> Clear
            </button>
          </div>
        )}
      </aside>
      <section className="cust-map">
        <MapContainer center={DEFAULT_CENTER} zoom={11} scrollWheelZoom className="leaflet-map">
          <OsmTiles />
          <MapSizer />
          <MapClicks mode={mode} onPick={pickOnMap} />
          {pickup && (
            <Marker position={[pickup.lat, pickup.lng]} icon={pickupIcon}>
              <Tooltip direction="top" offset={[0, -14]}>Pickup: {pickup.name}</Tooltip>
            </Marker>
          )}
          {drop && (
            <Marker position={[drop.lat, drop.lng]} icon={dropIcon}>
              <Tooltip direction="top" offset={[0, -14]}>Drop-off: {drop.name}</Tooltip>
            </Marker>
          )}
          {route && <Polyline positions={route.coords} pathOptions={{ color: "#2646c8", weight: 6, opacity: 0.88 }} />}
          <FitView pickup={pickup} drop={drop} route={route} />
        </MapContainer>
        <div className="map-hint">
          <Crosshair size={16} />
          Click the map to set {mode === "pickup" ? "pickup" : "drop-off"}
        </div>
        <div className="legend">
          <span><i className="dot" style={{ background: "var(--pickup)" }} /> Pickup</span>
          <span><i className="dot" style={{ background: "var(--drop)" }} /> Drop-off</span>
          <span><i style={{ background: "var(--route-opt)" }} /> Route</span>
        </div>
      </section>
      {confirmOpen && route && fare && (
        <Modal
          title="Confirm your booking"
          onClose={() => !submitting && setConfirmOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmOpen(false)} disabled={submitting}>Back</button>
              <button className="btn btn-primary" onClick={confirmBooking} disabled={submitting}>
                {submitting ? <><Loader2 size={16} className="spin" /> Placing…</> : `Confirm ₹${fare.total} & book`}
              </button>
            </>
          }
        >
          <div className="summary-row"><span>Pickup</span><strong>{pickup.name}</strong></div>
          <div className="summary-row"><span>Drop-off</span><strong>{drop.name}</strong></div>
          <div className="summary-row"><span>Package</span><strong>{item}</strong></div>
          <div className="summary-row"><span>Speed</span><strong>{priority === "express" ? "Express" : "Standard"}</strong></div>
          <div className="summary-row num"><span>Distance / time</span><strong>{route.distance.toFixed(1)} km · {Math.round(route.duration)} min</strong></div>
          <div className="summary-row summary-total num"><span>Total fare</span><strong>₹{fare.total}</strong></div>
        </Modal>
      )}
      {resetOpen && (
        <Modal
          title="Clear this delivery?"
          onClose={() => setResetOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setResetOpen(false)}>Keep editing</button>
              <button className="btn btn-primary" onClick={resetAll}>Clear delivery</button>
            </>
          }
        >
          <p>Pickup, drop-off and package details will be removed.</p>
        </Modal>
      )}
    </div>
  );
}
/* =====================================================
   RIDER APP
===================================================== */
function RiderApp({ data, toast }) {
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [riderError, setRiderError] = useState("");
  const [updating, setUpdating] = useState(null);
  const [sharing, setSharing] = useState(false);
  const watchRef = useRef(null);
  const lastSent = useRef(0);
  async function sendLocation(latitude, longitude, heading) {
    try {
      await fetch(`${API_BASE}/api/rider/location`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude, longitude, ...(Number.isFinite(heading) ? { heading } : {}) }),
      });
    } catch { /* the next GPS fix retries */ }
  }
  function toggleGps() {
    if (sharing) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
      setSharing(false);
      return;
    }
    if (!navigator.geolocation) { toast("Geolocation is not supported on this device", "error"); return; }
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (Date.now() - lastSent.current < 5000) return; // throttle: one update / 5 s
        lastSent.current = Date.now();
        sendLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.heading);
      },
      () => { toast("Location permission denied", "error"); setSharing(false); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    setSharing(true);
    toast("Sharing live location");
  }
  useEffect(() => () => { if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current); }, []);
  async function useDemoLocation() {
    await sendLocation(28.5355 + (Math.random() - 0.5) * 0.02, 77.391 + (Math.random() - 0.5) * 0.02);
    toast("Demo rider placed in Noida");
  }
  async function loadRiderOrders() {
    setOrdersLoading(true);
    setRiderError("");
    try {
      const res = await fetch(`${API_BASE}/api/rider/orders`);
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || `Request failed (${res.status})`);
      setOrders(Array.isArray(result) ? result : []);
    } catch (e) {
      setRiderError(e.message || "Unable to load rider orders");
    } finally {
      setOrdersLoading(false);
    }
  }
  useEffect(() => {
    loadRiderOrders();
    const timer = setInterval(loadRiderOrders, 15000);
    return () => clearInterval(timer);
  }, []);
  async function acceptOrder(order) {
    setUpdating(order.id);
    setRiderError("");
    try {
      const res = await fetch(`${API_BASE}/api/rider/orders/${order.id}/accept`, { method: "POST" });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || "Could not accept order");
      await loadRiderOrders();
      toast("Order accepted");
    } catch (e) {
      setRiderError(e.message || "Unable to accept order");
    } finally {
      setUpdating(null);
    }
  }
  async function advanceOrder(order) {
    const nextStatus = { ACCEPTED: "PICKED_UP", PICKED_UP: "IN_TRANSIT", IN_TRANSIT: "DELIVERED" }[order.status];
    if (!nextStatus) return;
    setUpdating(order.id);
    setRiderError("");
    try {
      const res = await fetch(`${API_BASE}/api/rider/orders/${order.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || "Status update failed");
      await loadRiderOrders();
      toast(`Order status updated to ${statusLabel(nextStatus)}`);
    } catch (e) {
      setRiderError(e.message || "Unable to update order");
    } finally {
      setUpdating(null);
    }
  }
  const activeOrders = orders.filter((o) => o.status !== "DELIVERED");
  const deliveredCount = orders.filter((o) => o.status === "DELIVERED").length;
  return (
    <>
      {riderError && <ErrorBanner message={riderError} onRetry={loadRiderOrders} />}
      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <div><strong>Rider Dashboard</strong><small className="note">Authentication disabled for demo</small></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className={`btn btn-sm ${sharing ? "btn-primary" : ""}`} onClick={toggleGps}><Crosshair size={14} /> {sharing ? "Stop sharing GPS" : "Share my GPS"}</button>
          <button className="btn btn-sm" onClick={useDemoLocation}><MapPin size={14} /> Demo location</button>
          <button className="btn btn-sm" onClick={loadRiderOrders} disabled={ordersLoading}><RefreshCw size={14} className={ordersLoading ? "spin" : ""} /> Refresh</button>
        </div>
      </div>
      <div className="kpis">
        <Kpi label="Active deliveries" value={activeOrders.length} loading={ordersLoading} />
        <Kpi label="Delivered" value={deliveredCount} loading={ordersLoading} />
        <Kpi label="Rider status" value="Online" good />
      </div>
      {ordersLoading ? <div className="skeleton" style={{ height: 180 }} /> : activeOrders.length === 0 ? (
        <div className="card"><Empty icon={Truck} title="No active deliveries" text="Pending orders and your assigned deliveries will appear here." /></div>
      ) : (
        <div className="rider-grid">
          {activeOrders.map((o) => {
            const flow = ["PENDING", "ACCEPTED", "PICKED_UP", "IN_TRANSIT", "DELIVERED"];
            const step = flow.indexOf(o.status);
            return (
              <article key={o.id} className="card order-card">
                <div className="order-top"><div><strong>{o.itemDescription || "Package"}</strong><small>Order {shortId(o.id)}</small></div><StatusBadge status={o.status} /></div>
                <div className="route-list">
                  <div className="route-stop"><span className="pin p">P</span><div><b>{o.pickupName || "Pickup point"}</b><p>{o.pickupAddress || "—"}</p></div></div>
                  <div className="route-stop"><span className="pin d">D</span><div><b>{o.dropName || "Destination"}</b><p>{o.dropAddress || "—"}</p></div></div>
                </div>
                <div className="order-meta num"><span>{o.priority || "Standard"}</span><span>₹{o.fare ?? "—"}</span><span>ETA {o.etaMinutes ?? "—"} min</span></div>
                <div className="steps" aria-hidden="true">{flow.map((s, i) => <i key={s} className={i <= step ? "done" : ""} />)}</div>
                <div className="order-foot">
                  {o.status === "PENDING" && !o.riderId ? <button className="btn btn-primary btn-block" onClick={() => acceptOrder(o)} disabled={updating === o.id}>{updating === o.id ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />} Accept order</button> :
                    <button className="btn btn-primary btn-block" onClick={() => advanceOrder(o)} disabled={updating === o.id || !({ ACCEPTED: true, PICKED_UP: true, IN_TRANSIT: true }[o.status])}>{updating === o.id ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />} {({ ACCEPTED: "Confirm pickup", PICKED_UP: "Start transit", IN_TRANSIT: "Mark delivered" }[o.status] || "No action")}</button>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
/* =====================================================
   ADMIN — ORDERS & RIDERS
===================================================== */
function AdminDashboard({ data }) {
  const { orders, riders, routes, loading, loaded, error, load } = data;
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [sort, setSort] = useState({ key: null, dir: "asc" });
  const [page, setPage] = useState(1);
  const riderName = useMemo(() => Object.fromEntries(riders.map((r) => [r.id, r.name || shortId(r.id)])), [riders]);
  const skeleton = loading && !loaded;
  const total = orders.length;
  const pending = orders.filter((o) => o.status === "PENDING").length;
  const active = orders.filter((o) => ["ACCEPTED", "ASSIGNED", "PICKED_UP", "IN_TRANSIT"].includes(o.status)).length;
  const delivered = orders.filter((o) => o.status === "DELIVERED").length;
  const busyIds = new Set(orders.filter((o) => ["ACCEPTED", "ASSIGNED", "PICKED_UP", "IN_TRANSIT"].includes(o.status)).map((o) => o.riderId));
  const available = riders.filter((r) => !busyIds.has(r.id)).length;
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = orders.filter((o) => {
      if (statusFilter !== "ALL" && o.status !== statusFilter) return false;
      if (!needle) return true;
      return [o.id, o.itemDescription, o.pickupName, o.pickupAddress, o.dropName, o.dropAddress, riderName[o.riderId]]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
    if (sort.key) {
      const val = (o) => (sort.key === "status" ? STATUS_FLOW.indexOf(o.status) : Number(o[sort.key]) || 0);
      list = [...list].sort((a, b) => (val(a) - val(b)) * (sort.dir === "asc" ? 1 : -1));
    }
    return list;
  }, [orders, q, statusFilter, sort, riderName]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const visible = rows.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);
  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  const SortTh = ({ k, children }) => (
    <th aria-sort={sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button onClick={() => toggleSort(k)}>{children}<ArrowUpDown size={13} /></button>
    </th>
  );
  return (
    <>
      <ErrorBanner message={error} onRetry={() => load()} />
      <div className="kpis">
        <Kpi label="Total orders" value={total} loading={skeleton} />
        <Kpi label="Pending" value={pending} loading={skeleton} />
        <Kpi label="Active deliveries" value={active} loading={skeleton} />
        <Kpi label="Delivered" value={delivered} loading={skeleton} />
        <Kpi label="Available riders" value={available} hint={`of ${riders.length}`} loading={skeleton} />
        <Kpi label="Route distance" value={fmtKm(routes?.optimizedDistance)} hint="Optimized, active orders" loading={skeleton} />
      </div>
      <div className="two-col">
        <section className="card">
          <div className="card-head">
            <div><h2>Orders</h2><p>{rows.length} of {total} orders</p></div>
            <div className="toolbar">
              <div className="input">
                <Search size={16} />
                <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search orders, places, riders" aria-label="Search orders" />
              </div>
              <div className="input select">
                <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} aria-label="Filter by status">
                  <option value="ALL">All statuses</option>
                  {STATUS_FLOW.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </select>
              </div>
            </div>
          </div>
          {skeleton ? (
            <div className="card-body" style={{ display: "grid", gap: 10 }}>
              {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 44 }} />)}
            </div>
          ) : visible.length === 0 ? (
            <Empty
              title={total === 0 ? "No orders yet" : "No orders match"}
              text={total === 0 ? "Book a delivery from the Customer portal and it will show up here." : "Try a different search or status filter."}
              action={total > 0 && <button className="btn btn-sm" onClick={() => { setQ(""); setStatusFilter("ALL"); }}>Reset filters</button>}
            />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Pickup</th>
                      <th>Drop-off</th>
                      <th>Rider</th>
                      <SortTh k="status">Status</SortTh>
                      <th>Type</th>
                      <SortTh k="fare">Fare</SortTh>
                      <SortTh k="etaMinutes">ETA</SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((o) => (
                      <tr key={o.id}>
                        <td data-label="Order"><div className="mono">{shortId(o.id)}</div><div className="sub">{o.itemDescription || "Package"}</div></td>
                        <td data-label="Pickup"><div>{o.pickupName || "—"}</div><div className="sub">{o.pickupAddress}</div></td>
                        <td data-label="Drop-off"><div>{o.dropName || "—"}</div><div className="sub">{o.dropAddress}</div></td>
                        <td data-label="Rider">{o.riderId ? riderName[o.riderId] || shortId(o.riderId) : <span className="note">Unassigned</span>}</td>
                        <td data-label="Status"><StatusBadge status={o.status} /></td>
                        <td data-label="Type"><PriorityBadge priority={o.priority} /></td>
                        <td data-label="Fare" className="mono">{o.fare != null ? `₹${o.fare}` : "—"}</td>
                        <td data-label="ETA" className="mono">{o.etaMinutes != null ? `${o.etaMinutes} min` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pager">
                <span>Page {cur} of {pages}</span>
                <div>
                  <button className="btn btn-sm" onClick={() => setPage(cur - 1)} disabled={cur <= 1} aria-label="Previous page"><ChevronLeft size={15} /></button>
                  <button className="btn btn-sm" onClick={() => setPage(cur + 1)} disabled={cur >= pages} aria-label="Next page"><ChevronRight size={15} /></button>
                </div>
              </div>
            </>
          )}
        </section>
        <section className="card">
          <div className="card-head"><div><h2>Riders</h2><p>{riders.length} in fleet</p></div></div>
          {skeleton ? (
            <div className="card-body"><div className="skeleton" style={{ height: 120 }} /></div>
          ) : riders.length === 0 ? (
            <Empty icon={Truck} title="No riders" text="Riders added to the database will appear here." />
          ) : (
            riders.map((r) => {
              const n = orders.filter((o) => o.riderId === r.id && o.status !== "DELIVERED").length;
              const lat = r.lat ?? r.latitude;
              const lng = r.lng ?? r.longitude;
              return (
                <div key={r.id} className="rider-row">
                  <div>
                    <strong>{r.name || "Rider"}</strong>
                    <small className="num">
                      {n} active order{n === 1 ? "" : "s"}
                      {lat != null && lng != null ? ` · ${Number(lat).toFixed(3)}, ${Number(lng).toFixed(3)}` : ""}
                    </small>
                  </div>
                  <span className={`badge ${busyIds.has(r.id) ? "s-in_transit" : "s-delivered"}`}>{busyIds.has(r.id) ? "On delivery" : r.status ? statusLabel(r.status) : "Available"}</span>
                </div>
              );
            })
          )}
        </section>
      </div>
    </>
  );
}
/* =====================================================
   RESEARCH DASHBOARD
===================================================== */
function groupExperiments(history) {
  const map = new Map();
  history.forEach((r, i) => {
    const key = r.experimentId ? `${r.experimentId}#${r.seed}` : `${r.batchSize}-${r.id ?? i}`;
    if (!map.has(key)) map.set(key, { id: key, batchSize: r.batchSize, createdAt: r.createdAt });
    const e = map.get(key);
    const alg = String(r.algorithm || "").toUpperCase();
    if (alg.startsWith("FIFO")) e.fifo = r;
    else if (alg === "EXACT") e.exact = r;
    else e.opt = r;
  });
  const list = [...map.values()];
  if (list.length && list.every((e) => e.createdAt)) list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return list;
}
function ResearchDashboard({ data, toast }) {
  const { routes, history, loading, loaded, error, load } = data;
  const [running, setRunning] = useState(null);
  const [runError, setRunError] = useState("");
  const [study, setStudy] = useState(null);
  const [studyRunning, setStudyRunning] = useState(false);
  async function runStudy(size, trials = 30) {
    setStudyRunning(true);
    setRunError("");
    try {
      const res = await fetch(`${API_BASE}/api/benchmark`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size, trials, matrix: "haversine" }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Study failed");
      setStudy(d);
      await load(true);
      toast(`${trials}-trial study completed`);
    } catch (e) {
      setRunError(e.message || "Study could not be completed");
    } finally {
      setStudyRunning(false);
    }
  }
  const experiments = useMemo(() => groupExperiments(history), [history]);
  const complete = experiments.filter((e) => e.fifo && e.opt);
  const latest = complete[0];
  const latestPct = latest ? reductionPct(latest.fifo.distanceKm, latest.opt.distanceKm) : null;
  const livePct = reductionPct(routes?.fifoDistance, routes?.optimizedDistance);
  const saved = Number.isFinite(routes?.optimizedDistance) && Number.isFinite(routes?.fifoDistance) ? routes.fifoDistance - routes.optimizedDistance : null;
  const hasGeometry = routes?.optimizedGeometry?.length && routes?.fifoGeometry?.length;
  async function run(size) {
    setRunning(size);
    setRunError("");
    try {
      const res = await fetch(`${API_BASE}/api/benchmark`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Benchmark failed");
      await load(true);
      toast(`${size}-order benchmark completed`);
    } catch (e) {
      setRunError(e.message || "Benchmark could not be completed");
    } finally {
      setRunning(null);
    }
  }
  const chartRows = complete.slice(0, 8);
  const maxKm = Math.max(1, ...chartRows.flatMap((e) => [Number(e.fifo.distanceKm) || 0, Number(e.opt.distanceKm) || 0]));
  const maxMs = Math.max(1, ...chartRows.flatMap((e) => [Number(e.fifo.computeMs) || 0, Number(e.opt.computeMs) || 0]));
  const skeleton = loading && !loaded;
  const Bars = ({ metric, max, fmt }) => (
    <div className="bars">
      {chartRows.map((e) => (
        <div className="bar-group" key={e.id}>
          <b>{e.batchSize} orders</b>
          <div className="bar-pair">
            <div className="bar fifo"><div><i style={{ width: `${Math.max(2, ((Number(e.fifo[metric]) || 0) / max) * 100)}%` }} /></div><span>{fmt(e.fifo[metric])}</span></div>
            <div className="bar opt"><div><i style={{ width: `${Math.max(2, ((Number(e.opt[metric]) || 0) / max) * 100)}%` }} /></div><span>{fmt(e.opt[metric])}</span></div>
          </div>
        </div>
      ))}
    </div>
  );
  const keyLegend = (
    <div className="legend inline">
      <span><i style={{ background: "var(--route-opt)" }} /> Optimized</span>
      <span><i className="dash" /> FIFO baseline</span>
    </div>
  );
  return (
    <>
      <ErrorBanner message={error} onRetry={() => load()} />
      {/* live comparison */}
      <section className="card">
        <div className="card-head">
          <div><h2>Live route comparison</h2><p>Active orders: precedence-safe optimized route vs FIFO baseline</p></div>
          <span className={`live ${routes ? "" : "off"}`}><i />{routes ? "Route API connected" : "Route API unavailable"}</span>
        </div>
        <div className="card-body" style={{ display: "grid", gap: 16 }}>
          <div className="kpis">
            <Kpi label="Orders in route" value={routes?.orders?.length ?? 0} loading={skeleton} />
            <Kpi label="FIFO distance" value={routes?.orders?.length ? fmtKm(routes?.fifoDistance) : "—"} hint={!routes?.orders?.length ? "No active orders" : undefined} loading={skeleton} />
            <Kpi label="Optimized distance" value={routes?.orders?.length ? fmtKm(routes?.optimizedDistance) : "—"} hint={!routes?.orders?.length ? "No active orders" : undefined} loading={skeleton} />
            <Kpi label="Distance saved" value={routes?.orders?.length && saved !== null ? `${saved.toFixed(2)} km` : "—"} hint={routes?.orders?.length && livePct !== null ? `${livePct.toFixed(1)}% shorter than FIFO` : "Create an order to calculate route savings"} good={saved > 0} loading={skeleton} />
          </div>
          {hasGeometry ? (
            <>
              {keyLegend}
              <div className="research-map" style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--line)" }}>
                <MapContainer center={DEFAULT_CENTER} zoom={11} scrollWheelZoom className="leaflet-map">
                  <OsmTiles />
                  <MapSizer />
                  <Polyline positions={routes.fifoGeometry} pathOptions={{ color: "#e07b00", weight: 5, opacity: 0.75, dashArray: "8 8" }} />
                  <Polyline positions={routes.optimizedGeometry} pathOptions={{ color: "#2646c8", weight: 6, opacity: 0.9 }} />
                  <FitView route={{ coords: routes.optimizedGeometry.concat(routes.fifoGeometry) }} />
                </MapContainer>
              </div>
            </>
          ) : (
            <Empty icon={Route} title="No route geometry yet" text="Route lines appear when there are active orders and a rider location." />
          )}
        </div>
      </section>
      {/* benchmark */}
      <section className="card">
        <div className="card-head">
          <div><h2>Algorithm benchmark</h2><p>The server generates a test batch, runs both algorithms and saves the result.</p></div>
          <div className="exp-actions">
            {[10, 25, 50].map((n) => (
              <button key={n} className="btn btn-primary" disabled={running !== null} onClick={() => run(n)}>
                {running === n ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
                {running === n ? "Running…" : `${n} orders`}
              </button>
            ))}
            <button className="btn" disabled={running !== null || studyRunning} onClick={() => runStudy(25)}>
              {studyRunning ? <Loader2 size={15} className="spin" /> : <FlaskConical size={15} />} 30-trial study (25 orders)
            </button>
            <a className="btn" href={`${API_BASE}/api/benchmark.csv`}><Download size={15} /> Export CSV</a>
          </div>
        </div>
        <div className="card-body" style={{ display: "grid", gap: 16 }}>
          {runError && <ErrorBanner message={runError} />}
          {study?.summary && (
            <div className="card" style={{ padding: 16 }}>
              <strong>Statistical study: {study.trials} independent seeds, {study.batchSize} orders</strong>
              <div className="note" style={{ marginTop: 6 }}>
                Distance saved vs FIFO: <b>{study.summary.distanceSavedPct.mean.toFixed(1)}%</b> mean
                (95% CI {study.summary.distanceSavedPct.ci95.low.toFixed(1)} to {study.summary.distanceSavedPct.ci95.high.toFixed(1)}%,
                SD {study.summary.distanceSavedPct.stddev.toFixed(1)}).
                {study.summary.pairedTTest && (
                  <> Paired t = {study.summary.pairedTTest.t.toFixed(2)} (df {study.summary.pairedTTest.df}),{" "}
                  {study.summary.pairedTTest.significant ? "significant at the 5% level" : "not significant at the 5% level"}.</>
                )}
                {" "}Mean optimiser runtime {study.summary.optimizedComputeMs.mean.toFixed(1)} ms. Matrix: {study.matrixSource}.
              </div>
            </div>
          )}
          {running !== null && (
            <div className="alert info"><Loader2 size={17} className="spin" /><span>Running {running}-order benchmark. This can take a while because it requests a route matrix.</span></div>
          )}
          {skeleton ? (
            <div className="skeleton" style={{ height: 120 }} />
          ) : latest ? (
            <div className="kpis">
              <Kpi label="Orders tested" value={latest.batchSize} hint="Latest experiment" />
              <Kpi label="FIFO distance" value={fmtKm(latest.fifo.distanceKm)} />
              <Kpi label="Optimized distance" value={fmtKm(latest.opt.distanceKm)} />
              <Kpi label="Distance reduction" value={latestPct !== null ? `${latestPct.toFixed(1)}%` : "—"} good={latestPct > 0} hint="(FIFO − optimized) ÷ FIFO" />
              <Kpi label="Runtime, FIFO" value={fmtMs(latest.fifo.computeMs)} />
              <Kpi label="Runtime, optimized" value={fmtMs(latest.opt.computeMs)} />
            </div>
          ) : (
            <Empty icon={FlaskConical} title="No benchmark runs saved" text="Pick a batch size above to run your first experiment." />
          )}
          {chartRows.length > 0 && (
            <div className="two-col" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
              <div style={{ display: "grid", gap: 12 }}>
                <h3 style={{ fontSize: 14 }}>Total distance by batch size (km)</h3>
                {keyLegend}
                <Bars metric="distanceKm" max={maxKm} fmt={(v) => `${Number(v).toFixed(1)} km`} />
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                <h3 style={{ fontSize: 14 }}>Compute time by batch size (ms)</h3>
                {keyLegend}
                <Bars metric="computeMs" max={maxMs} fmt={(v) => `${Number(v).toFixed(1)} ms`} />
              </div>
            </div>
          )}
        </div>
      </section>
      {/* history */}
      <section className="card">
        <div className="card-head"><div><h2>Benchmark history</h2><p>{complete.length} saved experiments</p></div></div>
        {complete.length === 0 ? (
          <Empty title="Nothing to show yet" text="Completed experiments are listed here with both algorithms side by side." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Orders</th>
                  <th>FIFO (km)</th>
                  <th>Optimized (km)</th>
                  <th>Reduction</th>
                  <th>FIFO (ms)</th>
                  <th>Optimized (ms)</th>
                </tr>
              </thead>
              <tbody>
                {complete.slice(0, 20).map((e) => {
                  const p = reductionPct(e.fifo.distanceKm, e.opt.distanceKm);
                  return (
                    <tr key={e.id}>
                      <td data-label="Orders" className="mono">{e.batchSize}</td>
                      <td data-label="FIFO (km)" className="mono">{Number(e.fifo.distanceKm).toFixed(2)}</td>
                      <td data-label="Optimized (km)" className="mono">{Number(e.opt.distanceKm).toFixed(2)}</td>
                      <td data-label="Reduction" className={`mono ${p > 0 ? "pos" : p < 0 ? "neg" : ""}`}>{p !== null ? `${p.toFixed(1)}%` : "—"}</td>
                      <td data-label="FIFO (ms)" className="mono">{Number(e.fifo.computeMs).toFixed(1)}</td>
                      <td data-label="Optimized (ms)" className="mono">{Number(e.opt.computeMs).toFixed(1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-body note">
          Distances and runtimes come from the backend and are stored in the database. Benchmark batches are generated by the server, so they are test data, not real customer orders.
        </div>
      </section>
    </>
  );
}
/* =====================================================
   APP SHELL
===================================================== */
const VIEWS = [
  { id: "customer", label: "Customer", title: "Book a delivery", sub: "Choose pickup and drop-off, see the route and fare.", icon: Package },
  { id: "rider", label: "Rider", title: "Rider app", sub: "Your assigned deliveries and the next action for each.", icon: Truck },
  { id: "admin", label: "Orders", title: "Operations", sub: "Orders and riders across the fleet.", icon: LayoutDashboard },
  { id: "research", label: "Research", title: "Route optimization research", sub: "Optimized routing compared with the FIFO baseline.", icon: FlaskConical },
];
export default function App() {
  const initial = VIEWS.find((v) => `#${v.id}` === window.location.hash)?.id || "customer";
  const [view, setView] = useState(initial);
  const [toasts, setToasts] = useState([]);
  const data = useBackend(true);
  const toast = useCallback((message, type = "success") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  useEffect(() => {
    const onHash = () => {
      const v = VIEWS.find((x) => `#${x.id}` === window.location.hash);
      if (v) setView(v.id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (id) => {
    setView(id);
    window.history.replaceState(null, "", `#${id}`);
  };
  const current = VIEWS.find((v) => v.id === view);
  const backendView = true;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Route size={19} /></div>
          <div><strong>SmartRoute</strong><span>Delivery platform</span></div>
        </div>
        <nav className="nav" aria-label="Main">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${view === id ? "active" : ""}`} onClick={() => go(id)} aria-current={view === id ? "page" : undefined}>
              <Icon size={18} /> {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">B.Tech final-year project</div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div>
            <h1>{current.title}</h1>
            <p>{current.sub}</p>
          </div>
          <div className="topbar-actions">
            {backendView && (
              <button className="btn btn-sm" onClick={() => data.load()} disabled={data.loading}>
                <RefreshCw size={14} className={data.loading ? "spin" : ""} /> Refresh
              </button>
            )}
            <span className={`live ${backendView && data.error ? "off" : ""}`}><i />{backendView && data.error ? "Backend offline" : "Live"}</span>
          </div>
        </header>
        <main className={`page ${view === "customer" ? "flush" : ""}`}>
          {view === "customer" && <CustomerPortal toast={toast} onBooked={() => data.load(true)} />}
          {view === "rider" && <RiderApp data={data} toast={toast} />}
          {view === "admin" && <AdminDashboard data={data} />}
          {view === "research" && <ResearchDashboard data={data} toast={toast} />}
        </main>
      </div>
      <nav className="bottom-nav" aria-label="Main">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id ? "active" : ""} onClick={() => go(id)}>
            <Icon size={20} />
            {label}
          </button>
        ))}
      </nav>
      <Toasts items={toasts} />
    </div>
  );
}
