// Run after signing a local notification fixture into an isolated agent-browser session.
// AGENT_BROWSER_SESSION=<session> node scripts/verify-notification-read-state.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const session = process.env.AGENT_BROWSER_SESSION;
assert(session, "Supply the isolated browser session");
function browser(...args) {
  return execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function evaluate(script) {
  const result = JSON.parse(browser("--json", "eval", script));
  assert(result.success, "Browser evaluation failed");
  return result.data.result;
}
const location = evaluate("window.location.href");
assert(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/notifications$/.test(location), "Use the local fixture inbox");
const user = evaluate("(async () => (await (await fetch('/api/me')).json()).user)()");
assert(user?.username.startsWith("notif_"), "Sign in to a notification fixture account");
const item = evaluate("(async () => (await (await fetch('/api/notifications')).json()).notifications[0])()");
assert(item, "The fixture inbox needs a notification");
const link = `a[href="/notifications/${item.id}"]`;
const button = `${link} + button`;
const originalRead = Boolean(item.readAt);
let currentRead = originalRead;

function waitForState(read) {
  browser("wait", "--fn", `(() => {
    const button = document.querySelector(${JSON.stringify(button)});
    return button && !button.disabled && button.textContent === ${JSON.stringify(read ? "Unread" : "Read")};
  })()`);
}
function assertAccessibleState(read) {
  const tree = browser("snapshot", "-s", link);
  assert(tree.includes(`link "${read ? "Read" : "Unread"} `),
    `Notification link omits its ${read ? "Read" : "Unread"} state: ${tree}`);
  console.log(JSON.stringify({ read, tree }));
}
try {
  waitForState(currentRead);
  assertAccessibleState(currentRead);
  browser("scrollintoview", button);
  browser("click", button);
  currentRead = !currentRead;
  waitForState(currentRead);
  assertAccessibleState(currentRead);
} finally {
  if (currentRead !== originalRead) {
    browser("click", button);
    waitForState(originalRead);
    assertAccessibleState(originalRead);
  }
}
console.log("Read and unread states appear in the link's accessible name; original state restored.");
