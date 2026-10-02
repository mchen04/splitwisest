"use client";

import { api } from "./client";
import type { NotificationSettings } from "./notification-types";

export type DevicePushStatus = "unsupported" | "install" | "denied" | "unavailable" | "development" | "off" | "on";
const DEVICE_KEY = "splitwisest.push-device";

export function pushSupport(): "unsupported" | "install" | "supported" {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (ios && !standalone) return "install";
  return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window ? "supported" : "unsupported";
}

function storedDevice(): { userId: number; id: number } | null {
  try { return JSON.parse(localStorage.getItem(DEVICE_KEY) ?? "null"); } catch { return null; }
}
function rememberDevice(userId: number, id: number) {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify({ userId, id })); } catch { /* Server ownership remains authoritative. */ }
}
export function forgetPushDevice() {
  try { localStorage.removeItem(DEVICE_KEY); } catch { /* Storage may be unavailable in private browsing. */ }
}

async function worker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) throw new Error("The app is still getting ready. Refresh and try again.");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The app is still getting ready. Refresh and try again.")), 8000);
    navigator.serviceWorker.ready.then((ready) => { clearTimeout(timeout); resolve(ready); }, (error) => { clearTimeout(timeout); reject(error); });
  });
}

function publicKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const value = key.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(value + "=".repeat((4 - value.length % 4) % 4)), (c) => c.charCodeAt(0));
}
function sameKey(subscription: PushSubscription, key: string): boolean {
  const bytes = subscription.options.applicationServerKey;
  if (!bytes) return true;
  const expected = publicKeyBytes(key); const actual = new Uint8Array(bytes);
  return expected.length === actual.length && expected.every((b, i) => b === actual[i]);
}
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Firefox/.test(ua)) return "Firefox";
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome/.test(ua)) return "Chrome";
  return "Safari";
}
async function saveSubscription(sub: PushSubscription, publicKey: string, userId: number): Promise<number> {
  const json = sub.toJSON();
  const { id } = await api<{ id: number }>("/api/push/subscriptions", { body: {
    endpoint: sub.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth, label: deviceLabel(), publicKey,
  } });
  rememberDevice(userId, id);
  return id;
}

export async function devicePushStatus(publicKey: string | null): Promise<{ status: DevicePushStatus; id: number | null }> {
  if (process.env.NODE_ENV === "development") return { status: "development", id: null };
  const support = pushSupport();
  if (support !== "supported") return { status: support, id: null };
  if (Notification.permission === "denied") return { status: "denied", id: null };
  if (!publicKey) return { status: "unavailable", id: null };
  if (Notification.permission !== "granted") return { status: "off", id: null };
  const sub = await (await worker()).pushManager.getSubscription();
  if (!sub || !sameKey(sub, publicKey)) return { status: "off", id: null };
  const { id } = await api<{ id: number | null }>("/api/push/subscriptions/status", { body: { endpoint: sub.endpoint } });
  return { status: id ? "on" : "off", id };
}

export async function enablePush(publicKey: string, userId: number): Promise<number> {
  if (process.env.NODE_ENV === "development") throw new Error("Use the hosted app to turn on notifications.");
  if (pushSupport() !== "supported") throw new Error("Install SplitWisest or use a supported browser first.");
  // Safari requires this call in the tap handler, before a network request or worker wait.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied"
    ? "Notifications are blocked. Allow them in your browser or device settings, then try again."
    : "Permission was not granted. Tap Turn on to try again.");
  const registration = await worker();
  let sub = await registration.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await api("/api/push/subscriptions", { method: "DELETE", body: { endpoint: sub.endpoint } });
    if (!await sub.unsubscribe()) throw new Error("Could not replace this device subscription. Try again.");
    sub = null;
  }
  sub ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(publicKey) });
  return saveSubscription(sub, publicKey, userId);
}

export async function disablePush(id: number | null): Promise<void> {
  // Remove server ownership first. If offline, leave the UI honest and retryable.
  if (id) await api("/api/push/subscriptions", { method: "DELETE", body: { id } });
  forgetPushDevice();
  if (pushSupport() === "supported") {
    const sub = await (await worker()).pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  }
}

let lastSync = 0;
export async function syncExistingPush(userId: number): Promise<void> {
  if (process.env.NODE_ENV === "development") return;
  if (pushSupport() !== "supported" || Date.now() - lastSync < 60_000) return;
  const saved = storedDevice();
  if (!saved || saved.userId !== userId) return;
  lastSync = Date.now();
  if (Notification.permission === "denied") { await disablePush(saved.id); return; }
  if (Notification.permission !== "granted") return;
  const registration = await worker();
  const sub = await registration.pushManager.getSubscription();
  if (!sub) return;
  const { id } = await api<{ id: number | null }>("/api/push/subscriptions/status", { body: { endpoint: sub.endpoint } });
  // A device removed from another browser must stay off until an explicit tap.
  if (!id) { forgetPushDevice(); return; }
  const { publicKey } = await api<NotificationSettings>("/api/notification-settings");
  if (!publicKey) return;
  if (!sameKey(sub, publicKey)) {
    await disablePush(id);
    // Key rotation can need a fresh tap in Safari; show Turn on instead of prompting on launch.
    return;
  }
  await saveSubscription(sub, publicKey, userId);
}
