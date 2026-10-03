import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { chromium } from "playwright-core";

const origin = process.env.SPLITWISEST_BASE_URL ?? "http://localhost:3476";
const evidence = process.env.MONTHLY_REMINDER_EVIDENCE_DIR;
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) || !evidence || !isAbsolute(evidence)
  || evidence.startsWith(process.cwd())) throw new Error("Use local retained fixtures and evidence outside the checkout");
const fixture: { users: { role: string; token: string }[]; balanceGroup: number } =
  JSON.parse(readFileSync(".monthly-fixtures.local.json", "utf8"));
mkdirSync(evidence, { recursive: true });
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function main() {
  const browser = await chromium.launch({ headless: true });
  const receipts = [];
  try {
    for (const device of ["desktop", "mobile"]) {
      for (const scope of ["group", "direct"]) {
        const who = fixture.users.find((u) => u.role === (scope === "group" ? "debtor" : "directA"));
        check(who, "Controlled browser account exists");
        const context = await browser.newContext({
          viewport: device === "desktop" ? { width: 1280, height: 850 } : { width: 390, height: 844 },
          colorScheme: device === "desktop" ? "dark" : "light", isMobile: device === "mobile",
          hasTouch: device === "mobile",
        });
        try {
          await context.addCookies([{ name: "sw_session", value: who.token, url: origin, httpOnly: true, sameSite: "Lax" }]);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.name));
          const inboxResponse = await page.request.get(origin + "/api/notifications");
          check(inboxResponse.ok(), "Controlled account can read its inbox");
          const inbox: { notifications: { id: number; title: string; href: string }[] } = await inboxResponse.json();
          const expectedHref = scope === "group" ? `/groups/${fixture.balanceGroup}?tab=balances` : "/balances";
          const item = inbox.notifications.find((n) => n.title === "Monthly settle-up reminder" && n.href === expectedHref);
          check(item, "Monthly reminder has the expected destination");
          await page.goto(origin + "/notifications");
          const link = page.locator(`main a[href="/notifications/${item.id}"]`);
          await link.waitFor({ state: "visible" });
          await link.scrollIntoViewIfNeeded();
          const bounds = await link.boundingBox();
          check(bounds && bounds.width > 100 && bounds.x >= 0 && bounds.x + bounds.width <= (device === "desktop" ? 1280 : 390),
            "Reminder text fits the viewport");
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
          check(!overflow, "Inbox has no horizontal overflow");
          await page.screenshot({ path: `${evidence}/${device}-${scope}-inbox.png`, fullPage: true });
          await link.click();
          await page.waitForURL((url) => url.pathname === (scope === "group" ? `/groups/${fixture.balanceGroup}` : "/balances"));
          if (scope === "group") {
            await page.getByRole("tabpanel", { name: "Balances section" }).waitFor({ state: "visible" });
            await page.getByRole("heading", { name: "Who owes who" }).waitFor({ state: "visible" });
            check(await page.getByRole("tab", { name: "Balances", exact: true }).getAttribute("aria-selected") === "true",
              "Notification navigation selects the group's balances tab");
          } else {
            await page.getByRole("heading", { name: "Balances", exact: true }).waitFor({ state: "visible" });
            await page.getByText("Monthly Test directB", { exact: true }).first().waitFor({ state: "visible" });
          }
          await page.screenshot({ path: `${evidence}/${device}-${scope}-destination.png`, fullPage: true });
          const opened = await page.request.get(origin + `/api/notifications/${item.id}`);
          check((await opened.json()).notification.readAt, "Opening the reminder marks it read");
          check(errors.length === 0, "Browser reports no uncaught errors");
          receipts.push({ device, scope, expectedHref, observedPath: new URL(page.url()).pathname,
            balancesVisible: true, markedRead: true, horizontalOverflow: false, uncaughtErrors: 0 });
          if (scope === "direct") {
            await page.goto(origin + "/settings#notifications");
            const preference = page.getByLabel("Settle-up reminders", { exact: true });
            await preference.waitFor({ state: "visible" });
            const original = await preference.isChecked();
            await Promise.all([
              page.waitForResponse((r) => r.url().endsWith("/api/notification-settings") && r.request().method() === "GET"),
              preference.click(),
            ]);
            await page.waitForFunction((expected) => [...document.querySelectorAll("label")]
              .find((label) => label.textContent?.trim() === "Settle-up reminders")?.querySelector("input")?.checked === expected, !original);
            check(await preference.isChecked() === !original, "Existing reminder preference saves in the UI");
            await Promise.all([
              page.waitForResponse((r) => r.url().endsWith("/api/notification-settings") && r.request().method() === "GET"),
              preference.click(),
            ]);
            await page.waitForFunction((expected) => [...document.querySelectorAll("label")]
              .find((label) => label.textContent?.trim() === "Settle-up reminders")?.querySelector("input")?.checked === expected, original);
            check(await preference.isChecked() === original, "Existing reminder preference restores in the UI");
            await page.goto(origin + "/notifications");
            await page.getByRole("link", { name: /Monthly settle-up reminder/ }).first().waitFor({ state: "visible" });
            receipts.push({ device, reminderPreferenceSaves: true, reminderPreferenceRestores: true, inboxRetained: true });
          }
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); }
  writeFileSync(`${evidence}/browser-proof.json`, JSON.stringify({ browser: "Chromium", productionBuild: true,
    safari: false, physicalPhone: false, receipts }, null, 2) + "\n");
  console.log(JSON.stringify(receipts, null, 2));
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message.split("\n")[0] : "Monthly browser verification failed");
  process.exitCode = 1;
});
