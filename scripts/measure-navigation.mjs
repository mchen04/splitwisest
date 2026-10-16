import { randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import { chromium } from "playwright-core";

const origin = process.env.ORIGIN ?? "https://127.0.0.1:3740";
const target = new URL(origin);
assert.equal(target.hostname, "127.0.0.1");
assert(/^374[0-9]$/.test(target.port));
const count = Number(process.env.N ?? 5);
const samples = [];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const stats = (values) => ({ median: median(values), min: Math.min(...values), max: Math.max(...values) });

const browser = await chromium.launch();
try {
  for (const profile of ["phone", "desktop"]) for (const destination of ["Chat", "Friends", "Groups"]) for (let i = 0; i < count; i++) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block", viewport: profile === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: profile === "phone", hasTouch: profile === "phone" });
    try {
      const login = await context.request.post(`${origin}/api/auth/login`, { data: { username: "maya_chen_bench", password: process.env.SPLITWISEST_MONEY_QA_PASSWORD ?? randomBytes(32).toString("hex") } });
      assert.equal(login.status(), 200);
      const page = await context.newPage();
      if (profile === "phone") await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const prefetch = [];
      page.on("request", (request) => { if (request.headers()["next-router-prefetch"]) prefetch.push(request.url()); });
      await page.goto(origin);
      await page.getByRole("link", { name: /Dinner Club/ }).first().waitFor({ state: "attached" });
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
      const prefetches = prefetch.length;
      const navigation = profile === "phone" ? page.getByRole("navigation", { name: "Main", exact: true }) : page.getByRole("complementary");
      const start = performance.now();
      await navigation.getByRole("link", { name: new RegExp(`^${destination}`) }).first().click();
      if (destination === "Chat") await page.getByRole("button", { name: /Diego Romero/ }).locator("visible=true").first().waitFor();
      else if (destination === "Friends") await page.getByRole("link", { name: "Open Diego Romero's profile" }).locator("visible=true").first().waitFor();
      else await page.locator("main").getByRole("link", { name: /Dinner Club/ }).locator("visible=true").first().waitFor();
      samples.push({ profile, destination, i, prefetches, navigationMs: Math.round(performance.now() - start) });
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
const summary = {};
for (const profile of ["phone", "desktop"]) for (const destination of ["Chat", "Friends", "Groups"]) {
  const rows = samples.filter((s) => s.profile === profile && s.destination === destination);
  summary[`${profile}/${destination}`] = { n: rows.length, prefetches: stats(rows.map((r) => r.prefetches)), navigationMs: stats(rows.map((r) => r.navigationMs)) };
}
console.log(JSON.stringify({ summary, samples }, null, 2));
