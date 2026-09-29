"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export class ApiClientError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; form?: FormData } = {}
): Promise<T> {
  const method = opts.method ?? (opts.body || opts.form ? "POST" : "GET");
  const res = await fetch(path, {
    method,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  if (res.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
    clearReadCache(true);
    location.href = "/login";
    throw new ApiClientError("Not authenticated", 401);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiClientError(json.error ?? "Request failed", res.status);
  // The read cache is only a stale-while-revalidate paint layer — apiCached
  // always fetches fresh — so mutations don't need to clear it (doing so made
  // remounting shells flash empty). Auth changes do clear it, so one account's
  // data never paints for another.
  if (method !== "GET") {
    // Keep stale values available for paint, but force the next read to reach
    // the server. Authentication changes must remove the previous owner data.
    for (const key of cacheTimes.keys()) cacheTimes.set(key, 0);
    if (path.startsWith("/api/auth")) clearReadCache(path.endsWith("/logout"));
  }
  return json as T;
}

// --- Read-side cache -------------------------------------------------------
// GET responses are cached at module level (stale-while-revalidate): a
// remounting hook renders the last known payload instantly while a fresh fetch
// runs in the background. Identical concurrent GETs share one request.
const dataCache = new Map<string, unknown>();
const cacheTimes = new Map<string, number>();
const cacheStoredAt = new Map<string, number>();
const inflight = new Map<string, Promise<unknown>>();
const requestGeneration = new Map<string, number>();
let cacheEpoch = 0;
const READ_CACHE_KEY = "splitwisest.read-cache.v1";
const CACHE_OWNER_COOKIE = "sw_cache_owner";
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FRESH_DEDUPE_MS = 1500;
const MAX_CACHE_ENTRIES = 80;
const MAX_CACHE_BYTES = 3_500_000;
let cacheHydrated = false;
let persistScheduled = false;

interface StoredReadCache {
  owner: string;
  entries: [string, unknown, number][];
}

function cacheOwner(): string | null {
  if (typeof document === "undefined") return null;
  const part = document.cookie.split("; ").find((item) => item.startsWith(`${CACHE_OWNER_COOKIE}=`));
  return part ? decodeURIComponent(part.slice(CACHE_OWNER_COOKIE.length + 1)) : null;
}

function clearReadCache(clearOwnerCookie = false) {
  cacheEpoch++;
  dataCache.clear();
  cacheTimes.clear();
  cacheStoredAt.clear();
  requestGeneration.clear();
  cacheHydrated = true;
  if (typeof window !== "undefined") {
    try { localStorage.removeItem(READ_CACHE_KEY); } catch {}
    if (clearOwnerCookie) {
      document.cookie = `${CACHE_OWNER_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
    }
  }
}

function hydrateReadCache() {
  if (cacheHydrated || typeof window === "undefined") return;
  cacheHydrated = true;
  const owner = cacheOwner();
  if (!owner) return;
  try {
    const raw = localStorage.getItem(READ_CACHE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as StoredReadCache;
    if (stored.owner !== owner || !Array.isArray(stored.entries)) {
      localStorage.removeItem(READ_CACHE_KEY);
      return;
    }
    const cutoff = Date.now() - MAX_CACHE_AGE_MS;
    for (const entry of stored.entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[2] !== "number") continue;
      if (entry[2] < cutoff) continue;
      dataCache.set(entry[0], entry[1]);
      // Persisted values paint immediately but always revalidate after reload.
      cacheTimes.set(entry[0], 0);
      cacheStoredAt.set(entry[0], entry[2]);
    }
  } catch {
    try { localStorage.removeItem(READ_CACHE_KEY); } catch {}
  }
}

function persistReadCache() {
  persistScheduled = false;
  if (typeof window === "undefined") return;
  const owner = cacheOwner();
  if (!owner) return;
  const entries = [...dataCache.entries()]
    .map(([path, value]) => [path, value, cacheStoredAt.get(path) ?? Date.now()] as [string, unknown, number])
    .sort((a, b) => b[2] - a[2])
    .slice(0, MAX_CACHE_ENTRIES);
  try {
    let payload = JSON.stringify({ owner, entries } satisfies StoredReadCache);
    while (payload.length > MAX_CACHE_BYTES && entries.length > 1) {
      entries.pop();
      payload = JSON.stringify({ owner, entries } satisfies StoredReadCache);
    }
    localStorage.setItem(READ_CACHE_KEY, payload);
  } catch {
    // Storage can be disabled or full. Memory caching still works.
  }
}

function scheduleCachePersist() {
  if (persistScheduled || typeof window === "undefined") return;
  persistScheduled = true;
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(persistReadCache, { timeout: 1000 });
  } else {
    globalThis.setTimeout(persistReadCache, 0);
  }
}

// Synchronous read of the last cached payload for a path (or null). Pages that
// manage their own fetch state use this to seed useState so a revisit renders
// the previous data instantly instead of flashing a skeleton.
export function cacheGet<T>(path: string): T | null {
  return (dataCache.get(path) as T | undefined) ?? null;
}

export function apiCached<T>(path: string, force = false): Promise<T> {
  const pending = inflight.get(path);
  if (!force && pending) return pending as Promise<T>;
  const cached = dataCache.get(path);
  const cachedAt = cacheTimes.get(path) ?? 0;
  if (!force && cached !== undefined && Date.now() - cachedAt < FRESH_DEDUPE_MS) {
    return Promise.resolve(cached as T);
  }
  const generation = (requestGeneration.get(path) ?? 0) + 1;
  requestGeneration.set(path, generation);
  const epoch = cacheEpoch;
  const p = api<T>(path)
    .then((json) => {
      if (cacheEpoch === epoch && requestGeneration.get(path) === generation) {
        dataCache.set(path, json);
        const now = Date.now();
        cacheTimes.set(path, now);
        cacheStoredAt.set(path, now);
        scheduleCachePersist();
      }
      return json;
    })
    .finally(() => { if (inflight.get(path) === p) inflight.delete(path); });
  inflight.set(path, p);
  return p as Promise<T>;
}

// Money formatting lives in the framework-agnostic money lib so server routes
// and client components share one implementation.
export { fmtMoney, amountInputToCents } from "./money";

export function fmtDate(d: string | Date): string {
  return new Date(typeof d === "string" && d.length === 10 ? d + "T00:00:00" : d).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric", year: "numeric" }
  );
}

export function fmtTime(d: string | Date): string {
  return new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayStr(): string {
  return localDateStr(new Date());
}

export interface Unread {
  messages: number;
  activity: number;
  nudges: number;
  requests: number;
  balances: number;
}

export interface SyncCursors {
  activityCursor: number;
  messageCursor: number;
  nudgeCursor: number;
  requestCursor: number;
  unread?: Unread;
}

// Mark a read scope ('activity', 'msg:group:<id>', 'msg:dm:<friendId>') seen up
// to lastId. Fire-and-forget — a failed mark just leaves the badge until the
// next view.
export function markRead(scope: string, lastId: number) {
  api("/api/read", { body: { scope, lastId } }).catch(() => {});
}

// --- Shared sync poller ----------------------------------------------------
// One module-level loop polls /api/sync and fans the cursors out to every
// subscriber. Previously each useUnread/useSync/useApiData instance ran its
// own polling loop, so a busy page issued the same request several times per
// tick. The loop runs only while at least one subscriber is mounted.
const SYNC_INTERVAL_MS = 4000;
const syncListeners = new Set<(c: SyncCursors) => void>();
let lastSync: SyncCursors | null = null;
let syncLoopRunning = false;
let syncWake: (() => void) | null = null;

function ensureSyncLoop() {
  if (syncLoopRunning) return;
  syncLoopRunning = true;
  (async () => {
    while (syncListeners.size > 0) {
      try {
        const c = await api<SyncCursors>("/api/sync");
        lastSync = c;
        for (const l of [...syncListeners]) l(c);
      } catch {
        // offline or logged out; keep trying quietly
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, document.hidden ? SYNC_INTERVAL_MS * 4 : SYNC_INTERVAL_MS);
        syncWake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      syncWake = null;
    }
    syncLoopRunning = false;
  })();
}

function subscribeSync(listener: (c: SyncCursors) => void): () => void {
  syncListeners.add(listener);
  ensureSyncLoop();
  return () => {
    syncListeners.delete(listener);
    if (syncListeners.size === 0) syncWake?.();
  };
}

// Exposes the latest unread counts for nav badges via the shared sync poller.
export function useUnread(): Unread {
  const [unread, setUnread] = useState<Unread>(
    () => lastSync?.unread ?? { messages: 0, activity: 0, nudges: 0, requests: 0, balances: 0 }
  );
  useEffect(() => subscribeSync((c) => {
    if (!c.unread) return;
    const u = c.unread;
    // Keep the previous object when counts are unchanged so the shell doesn't
    // re-render (and repaint) on every poll tick.
    setUnread((prev) =>
      prev.messages === u.messages && prev.activity === u.activity && prev.nudges === u.nudges &&
      prev.requests === u.requests && prev.balances === u.balances ? prev : u
    );
  }), []);
  return unread;
}

// Invokes onChange when a sync cursor advances. Scoped data can opt into every
// response so a lower global activity ID cannot hide a later commit.
export function useSync(onChange: ((c: SyncCursors, prev: SyncCursors, initial: boolean) => void) | undefined,
  everyResponse = false) {
  const enabled = !!onChange;
  const last = useRef<SyncCursors | null>(null);
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  }, [onChange]);
  useEffect(() => {
    if (!enabled) return;
    return subscribeSync((c) => {
      const prev = last.current;
      last.current = c;
      if (everyResponse || prev && (
        c.activityCursor !== prev.activityCursor ||
        c.messageCursor !== prev.messageCursor ||
        c.nudgeCursor !== prev.nudgeCursor ||
        c.requestCursor !== prev.requestCursor
      )) {
        cb.current?.(c, prev ?? c, !prev);
      }
    });
  }, [enabled, everyResponse]);
}

// Fetches `path`, refreshes on every sync tick, and exposes a manual reload.
// `debounceMs` delays the fetch (used for search-as-you-type). Existing pages
// can keep rendering skeletons off `data === null`, while newer flows can show
// the returned error instead of looking like they are loading forever.
export function useApiData<T>(
  path: string,
  debounceMs = 0,
  opts: { sync?: false | keyof SyncCursors | (keyof SyncCursors)[]; enabled?: boolean } = {}
): { data: T | null; error: string | null; status: number | null; reload: () => void; reloadFresh: () => void } {
  const enabled = opts.enabled !== false;
  const [state, setState] = useState<{ path: string; data: T | null; error: string | null; status: number | null }>({
    path,
    data: null,
    error: null,
    status: null,
  });
  const requestSeq = useRef(0);
  const fetchData = useCallback((force: boolean) => {
    const requestedPath = path;
    const seq = ++requestSeq.current;
    apiCached<T>(path, force)
      .then((next) => {
        if (seq !== requestSeq.current) return;
        setState({ path: requestedPath, data: next, error: null, status: 200 });
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        const stale = cacheGet<T>(requestedPath);
        setState({
          path: requestedPath,
          data: stale,
          error: stale ? null : err instanceof ApiClientError ? err.message : "Could not load data",
          status: err instanceof ApiClientError ? err.status : null,
        });
      });
  }, [path]);
  const reload = useCallback(() => fetchData(false), [fetchData]);
  const reloadFresh = useCallback(() => fetchData(true), [fetchData]);
  useLayoutEffect(() => {
    if (!enabled) return;
    hydrateReadCache();
    const stale = cacheGet<T>(path);
    if (stale === null) return;
    // A layout update replaces the server skeleton before the first paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((current) => current.path === path && current.data !== null
      ? current
      : { path, data: stale, error: null, status: null });
  }, [path, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(reload, debounceMs);
    return () => clearTimeout(t);
  }, [reload, debounceMs, enabled]);
  const syncKeys =
    opts.sync === false ? null : Array.isArray(opts.sync) ? opts.sync : opts.sync ? [opts.sync] : null;
  useSync(
    !enabled || opts.sync === false
      ? undefined
      : syncKeys
        ? (c, prev) => {
            if (syncKeys.some((key) => c[key] !== prev[key])) reload();
          }
        : reload
  );
  // While the fresh fetch is in flight (or after a path change), serve the
  // last cached payload for this path so navigation renders instantly.
  const cached = (dataCache.get(path) as T | undefined) ?? null;
  return {
    data: enabled ? state.path === path ? state.data ?? cached : cached : null,
    error: enabled && state.path === path ? state.error : null,
    status: enabled && state.path === path ? state.status : null,
    reload,
    reloadFresh,
  };
}

// Form submission state for modals: tracks error + busy and wraps a submit in
// the canonical try/catch that unwraps ApiClientError to a user-facing message.
export function useFormState() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<void>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }, []);
  return { error, setError, busy, run };
}

// String-valued filter bar state: per-key onChange setters, a reset, and an
// `active` flag (any field non-empty). Used by the expense list filter UIs.
export function useFilters<T extends Record<string, string>>(initial: T) {
  const [filters, setFilters] = useState(initial);
  const setFilter = (k: keyof T) => (e: { target: { value: string } }) =>
    setFilters((f) => ({ ...f, [k]: e.target.value }));
  const reset = () => setFilters(initial);
  return { filters, setFilter, reset, active: Object.values(filters).some(Boolean) };
}

interface MeUser { id: number; username: string; displayName: string; inviteCode: string }

export function useMe() {
  const { data } = useApiData<{ user: MeUser }>("/api/me", 0, { sync: false });
  return data?.user ?? null;
}

export { CURRENCIES } from "./currencies";
