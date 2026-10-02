import { ECDH } from "node:crypto";
import webpush from "web-push";

export interface PushKeys { publicKey: string; privateKey: string; subject: string }
export interface StoredPushSubscription { endpoint: string; p256dh: string; auth: string }
export type PushResult = { outcome: "sent" | "gone" | "retry" | "failed"; status: number | null; retryAfter?: number };

export function pushKeys(): PushKeys | null {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = process.env;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

// Empty is deliberately off. Preview can only notify the explicitly named test accounts.
export function allowedPushUsers(): number[] | null {
  const value = process.env.PUSH_ALLOWED_USER_IDS?.trim() ?? "";
  if (value === "all") return null;
  return value.split(",").filter((id) => /^[1-9]\d*$/.test(id.trim())).map(Number).filter(Number.isSafeInteger);
}
export function pushAllowedFor(userId: number): boolean {
  const allowed = allowedPushUsers();
  return allowed === null || allowed.includes(userId);
}

export function validPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return endpoint.length <= 2048 && url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
      (url.hostname === "fcm.googleapis.com" ||
        [".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com"].some((suffix) => url.hostname.endsWith(suffix)));
  } catch { return false; }
}

export function validSubscriptionKeys(p256dh: string, auth: string): boolean {
  if (!/^[A-Za-z0-9_-]{87}$/.test(p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(auth)) return false;
  try {
    const key = Buffer.from(p256dh, "base64url");
    return key.length === 65 && key[0] === 4 && Buffer.from(auth, "base64url").length === 16 &&
      ECDH.convertKey(key, "prime256v1").length === 65;
  } catch { return false; }
}

export async function sendPush(
  subscription: StoredPushSubscription, payload: { notificationId: number; url: string; test: boolean },
  keys: PushKeys, send: typeof fetch = fetch,
): Promise<PushResult> {
  if (!validPushEndpoint(subscription.endpoint) || !validSubscriptionKeys(subscription.p256dh, subscription.auth)) {
    return { outcome: "gone", status: null };
  }
  // Keep names, message text, and all financial details off the lock screen.
  const request = webpush.generateRequestDetails({ endpoint: subscription.endpoint, keys: {
    p256dh: subscription.p256dh, auth: subscription.auth,
  } }, JSON.stringify({ ...payload, title: "SplitWisest", body: payload.test
    ? "Open this test notification to confirm tap-through."
    : "You have new activity. Open SplitWisest to view it." }), {
    vapidDetails: keys, TTL: 24 * 60 * 60, urgency: "normal",
    topic: `notification-${payload.notificationId}`,
  });
  try {
    const response = await send(request.endpoint, {
      method: "POST", headers: request.headers as Record<string, string>,
      body: new Uint8Array(request.body!), redirect: "error", signal: AbortSignal.timeout(8000),
    });
    const status = response.status;
    const retryHeader = response.headers.get("retry-after");
    await response.body?.cancel();
    if (response.ok) return { outcome: "sent", status };
    if (status === 404 || status === 410) return { outcome: "gone", status };
    const retryAfter = retryHeader ? Math.min(3600, Math.max(60,
      /^\d+$/.test(retryHeader) ? Number(retryHeader) : (Date.parse(retryHeader) - Date.now()) / 1000)) : undefined;
    return { outcome: status === 429 || status >= 500 ? "retry" : "failed", status,
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined };
  } catch {
    return { outcome: "retry", status: null };
  }
}
