import { createECDH, randomBytes, hkdfSync, createDecipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { sendPush, validPushEndpoint, validSubscriptionKeys, type PushKeys } from "../web-push";
import { safeNotificationPath } from "../notification-types";

const pair = createECDH("prime256v1"); pair.generateKeys();
const secret = randomBytes(16);
const subscription = { endpoint: "https://web.push.apple.com/fixture", p256dh: pair.getPublicKey().toString("base64url"), auth: secret.toString("base64url") };
const vapid: PushKeys = { ...webpush.generateVAPIDKeys(), subject: "https://splitwisest.example" };

function decrypt(body: Uint8Array) {
  const packet = Buffer.from(body); const salt = packet.subarray(0, 16);
  const key = packet.subarray(21, 21 + packet[20]);
  const shared = pair.computeSecret(key);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), pair.getPublicKey(), key]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, secret, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const ciphertext = packet.subarray(21 + packet[20]);
  const cipher = createDecipheriv("aes-128-gcm", cek, nonce); cipher.setAuthTag(ciphertext.subarray(-16));
  const plaintext = Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]);
  expect(plaintext.at(-1)).toBe(2);
  return JSON.parse(plaintext.subarray(0, -1).toString("utf8"));
}

describe("Web Push transport", () => {
  it("encrypts a private payload a separate receiver can decrypt", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async (endpoint, init) => {
      expect(endpoint).toBe(subscription.endpoint);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const decoded = decrypt(init?.body as Uint8Array);
      expect(decoded).toEqual({ notificationId: 12, url: "/notifications/12", test: false, title: "SplitWisest",
        body: "You have new activity. Open SplitWisest to view it." });
      return new Response(null, { status: 201 });
    });
    await expect(sendPush(subscription, { notificationId: 12, url: "/notifications/12", test: false }, vapid, send))
      .resolves.toEqual({ outcome: "sent", status: 201 });
    expect(send).toHaveBeenCalledOnce();
  });
  it.each([404, 410, 429, 500, 403])("classifies HTTP %s without exposing response details", async (status) => {
    const result = await sendPush(subscription, { notificationId: 1, url: "/notifications/1", test: true }, vapid,
      vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive endpoint detail", { status, headers: { "retry-after": "180" } })));
    expect(result.outcome).toBe([404, 410].includes(status) ? "gone" : status === 429 || status >= 500 ? "retry" : "failed");
    expect(JSON.stringify(result)).not.toContain("sensitive");
    if (status === 429) expect(result.retryAfter).toBe(180);
  });
  it("retries a network failure and rejects malformed subscriptions before any request", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("private address in transport error"));
    expect((await sendPush(subscription, { notificationId: 1, url: "/notifications/1", test: false }, vapid, send)).outcome).toBe("retry");
    send.mockClear();
    expect((await sendPush({ ...subscription, endpoint: "https://localhost/" }, { notificationId: 1, url: "/notifications/1", test: false }, vapid, send)).outcome).toBe("gone");
    expect(send).not.toHaveBeenCalled();
  });
  it("accepts only push provider HTTPS origins and real curve keys", () => {
    for (const url of ["https://fcm.googleapis.com/send/a", "https://web.push.apple.com/a", "https://updates.push.services.mozilla.com/a", "https://wns2.notify.windows.com/a"]) expect(validPushEndpoint(url)).toBe(true);
    for (const url of ["http://fcm.googleapis.com/a", "https://localhost/a", "https://fcm.googleapis.com.evil.test/a", "https://u:p@web.push.apple.com/a", "https://web.push.apple.com:123/a", "https://push.apple.com/a"]) expect(validPushEndpoint(url)).toBe(false);
    expect(validSubscriptionKeys(subscription.p256dh, subscription.auth)).toBe(true);
    const bogus = Buffer.alloc(65); bogus[0] = 4;
    expect(validSubscriptionKeys(bogus.toString("base64url"), subscription.auth)).toBe(false);
  });
  it("confines notification destinations to app routes", () => {
    for (const url of ["//outside.test", "/\\outside.test", "/%5cevil", "/api/auth/logout", "javascript:alert(1)", "/groups/../api/me", "/\n/outside"]) expect(safeNotificationPath(url)).toBe("/notifications");
    expect(safeNotificationPath("/groups/23?expense=42")).toBe("/groups/23?expense=42");
    expect(safeNotificationPath("/notifications?test=opened")).toBe("/notifications?test=opened");
  });
});
