"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createDraftGuard } from "@/lib/draft-guard";
import { decideUpdateAction } from "@/lib/update-policy";

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID;
const RELOAD_KEY = "splitwisest.reloadedFor";
const POLL_INTERVAL_MS = 60 * 1000;
const SIGNAL_THROTTLE_MS = 5 * 1000;
const DEFER_RETRY_MS = 15 * 1000;

// Safari private mode throws on sessionStorage writes; an update path that
// dies on that throw is silent forever. Fall back to per-page memory (weaker
// loop protection, but the decide() guard still stops the common loop).
const memoryStore = new Map<string, string>();
function storageGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return memoryStore.get(key) ?? null;
  }
}
function storageSet(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    memoryStore.set(key, value);
  }
}

/** Ask the controlling worker which build its script was generated from. */
function askControllerBuild(): Promise<string | null> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => resolve(null), 3000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      const build = event.data?.build;
      resolve(typeof build === "string" && build ? build : null);
    };
    controller.postMessage({ type: "GET_BUILD" }, [channel.port2]);
  });
}

export function ServiceWorkerRegistration() {
  const router = useRouter();
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "SPLITWISEST_NOTIFICATION_CLICK") return;
      const url = event.data.url;
      if (typeof url !== "string" || !/^\/notifications(?:\/\d+)?$/.test(url)) return;
      router.push(url);
      event.ports[0]?.postMessage({ opened: true });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // The SW caches /_next/static/ cache-first, which is only safe for
    // production's content-hashed chunk names. In dev those names are stable,
    // so a registered SW serves stale code — unregister it and purge caches.
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations()
        .then((rs) => Promise.all(rs.map((r) => r.unregister())))
        .catch(() => {});
      if ("caches" in window) {
        caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
      }
      return;
    }

    let registration: ServiceWorkerRegistration | null = null;
    let reloading = false;
    let updateDeferred = false;
    let lastCheck = 0;
    const draftGuard = createDraftGuard();

    // Every signal ends here. /sw.js embeds the build id, so the browser's own
    // update algorithm is the mechanism: registration.update() fetches the
    // script, new bytes install and take control, and this reconciliation sees
    // a controller whose build differs from the one compiled into this page.
    // Without a controlling worker (first visit, private mode, evicted
    // registration) the same decision runs on /api/version instead.
    let reconciling = false;
    const reconcile = async () => {
      // The latch keeps two overlapping signals from racing past decide() into
      // a second reload.
      if (reloading || reconciling) return;
      reconciling = true;
      try {
        await reconcileInner();
      } finally {
        reconciling = false;
      }
    };
    const reconcileInner = async () => {
      const controllerBuild = await askControllerBuild();
      // The server's build is only needed to tell "page behind" from "worker
      // behind" — skip the request in the common everything-agrees case.
      const serverBuild = !controllerBuild || controllerBuild !== BUILD_ID
        ? await fetchServerBuild()
        : null;
      const action = decideUpdateAction({
        pageBuild: BUILD_ID,
        controllerBuild,
        serverBuild,
        alreadyReloadedFor: storageGet(RELOAD_KEY),
        hasUnsavedInput: draftGuard.hasUnsavedInput(),
      });
      if (action === "reload") {
        storageSet(RELOAD_KEY, (controllerBuild ?? serverBuild) as string);
        reloading = true;
        window.location.reload();
        return;
      }
      updateDeferred = action === "defer";
      if (controllerBuild && BUILD_ID) {
        // Report truthfully which build this window runs; the worker frees the
        // previous build's files only when every window is current.
        navigator.serviceWorker.controller?.postMessage({ type: "CLIENT_READY", build: BUILD_ID });
      }
    };

    const fetchServerBuild = async (): Promise<string | null> => {
      try {
        const response = await fetch("/api/version", { cache: "no-store" });
        if (!response.ok) return null;
        const version: unknown = (await response.json()).version;
        return typeof version === "string" && version ? version : null;
      } catch {
        return null; // Offline, or the deploy is mid-flight. The next signal retries.
      }
    };

    const check = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      if (Date.now() - lastCheck < SIGNAL_THROTTLE_MS) return;
      lastCheck = Date.now();
      registration?.update().catch(() => {});
      void reconcile();
    };

    const onControllerChange = () => void reconcile();
    const onFocusOut = () => {
      if (updateDeferred) void reconcile();
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
      .then((next) => {
        registration = next;
        check();
      })
      .catch(() => {});
    // iOS pauses timers in the background, so resume and connectivity signals
    // — not the interval alone — drive detection: visibilitychange, pageshow
    // (including restore from the back/forward cache), and online.
    document.addEventListener("input", draftGuard.trackText, true);
    document.addEventListener("change", draftGuard.trackChoice, true);
    document.addEventListener("click", draftGuard.trackStatefulButton, true);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    window.addEventListener("online", check);
    // A soft navigation is also a moment the user expects freshness, and the
    // App Router may serve it from its prefetch cache with no request this
    // worker ever sees. Piggyback the check on history changes.
    const origPushState = window.history.pushState.bind(window.history);
    const origReplaceState = window.history.replaceState.bind(window.history);
    window.history.pushState = (...args) => { origPushState(...args); setTimeout(check, 1000); };
    window.history.replaceState = (...args) => { origReplaceState(...args); setTimeout(check, 1000); };
    window.addEventListener("popstate", check);
    document.addEventListener("focusout", onFocusOut);
    const timer = window.setInterval(check, POLL_INTERVAL_MS);
    const deferTimer = window.setInterval(() => {
      if (updateDeferred) void reconcile();
    }, DEFER_RETRY_MS);
    navigator.storage?.persist?.().catch(() => {});
    return () => {
      window.clearInterval(timer);
      window.clearInterval(deferTimer);
      document.removeEventListener("input", draftGuard.trackText, true);
      document.removeEventListener("change", draftGuard.trackChoice, true);
      document.removeEventListener("click", draftGuard.trackStatefulButton, true);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("online", check);
      window.history.pushState = origPushState;
      window.history.replaceState = origReplaceState;
      window.removeEventListener("popstate", check);
      document.removeEventListener("focusout", onFocusOut);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);
  return null;
}
