# Notifications

The inbox uses `/notifications`; device controls use `/settings#notifications`.
Phone preferences do not hide inbox entries.
Inbox entries expire after 90 days.
Reading chat marks its message notifications read.
Resolving requests or dismissing reminders marks their related notifications read.
Mark all read stops at the visible newest ID, so a later arrival stays unread.

## Event rules

| Event | Recipients | Destination |
|---|---|---|
| Expense or receipt change | Current group members except actor. | Expense; group activity after deletion. |
| Recurring rule change | Current group members except actor. | Group activity. |
| Recurring expense or paused invalid rule | Current group members, including owner. | Expense or group activity. |
| Group payment or group balance change | Current group members except actor. | Group balances. |
| Direct payment change | Other participant. | Balances. |
| Expense comment | Current group members except author. | Expense. |
| Group or direct message | Group members except sender, or other current friend. | Chat. |
| Manual reminder | Named recipient. | Balances. |
| Group join, rename, or member departure | Other current members; removed member when another user removes them. | Group activity or Groups. |
| Group deletion | Previous members except creator. | Groups. |
| Friend request, acceptance, or removal | Recipient or other party. | Balances. |
| Personal-invite signup | Inviter. | Balances. |
| Device test | Selected device in the current session. | Test confirmation. |

Group balance notices use the existing `settlements` phone preference.
They include members without an allocation.
Failed writes, version conflicts, and repeated creates do not add duplicate notices.
Notifications follow current group membership and friendship access.
Deleted groups remove old scoped entries and retain a separate deletion notice.
Ordinary signup, account settings, exports, filters, and read-state changes do not create activity alerts.

## Monthly reminders

The delivery endpoint creates monthly reminders on day one, from 17:00 through 23:59:59 UTC.
Later days do not backfill a missed month.
Each eligible user gets one entry per outstanding group and one entry for all outstanding direct balances.
Both debtors and creditors qualify.
Group nets include expenses, group balance allocations, and recorded payments.
Direct balances require a current friendship and a nonzero net in at least one currency.
Groups, friends, and currencies do not cancel each other across scopes.
Recurring expenses count only after normal app reads materialize them.

Unique user/event keys prevent duplicate monthly entries.
The insert and delivery-job trigger share one transaction.
The `reminders` preference controls phone delivery, not inbox creation.
Delivery rechecks the balance and skips a phone alert if its scope has settled.
The inbox entry remains readable.
Monthly reminders do not create nudges, activity entries, or financial records.

## Setup

Apply the [notification migration](DATABASE.md#production-migrations) before deploying dependent code.
Generate a separate VAPID pair for each environment with `web-push.generateVAPIDKeys()`.
Keep private keys and scheduler secrets in the deployment environment store.

| Variable | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | Public VAPID key. |
| `VAPID_PRIVATE_KEY` | Matching server-only private key. |
| `VAPID_SUBJECT` | Operator HTTPS contact URL or mailto URI. |
| `PUSH_ALLOWED_USER_IDS` | Empty disables push; comma-separated user IDs restrict it; `all` permits opted-in users. |
| `PUSH_CRON_SECRET` | At least 32 random characters for the delivery endpoint. |
| `CRON_SECRET` | Same value as `PUSH_CRON_SECRET`, so Vercel sends the accepted bearer token. |

Begin rollout with controlled test accounts.
Only allowed users can enroll devices and receive phone alerts.
Other users retain their inbox.
Do not reuse account IDs across environments.

## Schedules and retries

Both schedulers call `/api/notifications/deliver` with the same bearer secret.

| Scheduler | UTC schedule | Method |
|---|---|---|
| Vercel, configured in `vercel.json` | Daily at 17:00, `0 17 * * *`. | GET |
| GitHub Actions, `notification-delivery.yml` | Every six hours at minute 23, `23 */6 * * *`. | POST |

Set GitHub repository secrets `PUSH_DELIVERY_URL` and `PUSH_CRON_SECRET`.
The URL must be the full production HTTPS delivery endpoint.
Manual retries use POST with the same bearer token.
A preview requires its own configuration and manual calls.
Rotate both Vercel secrets and the GitHub secret together, then redeploy.

Successful mutations and group detail, expense, and version reads request delivery after their responses when push is configured.
Scheduled calls retry without an open app.
A retry can wait for the next scheduled call; jobs older than 24 hours are skipped.
Only calls identified as `vercel-cron` run retention cleanup.
The daily Vercel call deletes up to 500 expired inbox entries and 100 expired-session subscriptions.
Cleanup and the delivery claim share one database round trip when push is enabled.
An expired provider endpoint can still be removed during any delivery attempt.

The sender claims up to 24 jobs with two-minute leases and sends four at a time.
Network errors, 429, and 5xx responses retry with delays from one minute to one hour.
It respects Retry-After within those bounds and stops after eight attempts.
404 and 410 remove the subscription; other 4xx responses fail the job.
Expired leases allow recovery after a stopped process.
A crash after provider acceptance can cause another send.

Receipts report accepted, retried, removed, skipped, failed, and remindersCreated counts.
Provider acceptance does not prove that a phone displays an alert.

## Device and privacy rules

Phone alerts need HTTPS, a production build, a service worker, browser permission, and an enrolled device.
The development server unregisters service workers.
Use the installed Home Screen app for iPhone checks.
Each account supports ten subscriptions with unexpired sessions.
Logout, session replacement, and revocation remove related subscriptions.
Session expiry stops delivery; sign in and enable notifications again.
VAPID rotation also requires device enrollment again.

The sender rechecks ownership, access, read state, preferences, session validity, and the VAPID key.
New devices and changed preferences do not create jobs for past entries.
Push text contains no names, amounts, expense titles, or message text.
Taps open an authenticated same-origin notification page.
The worker shows received pushes even when the app is visible.
It never stores API responses or push credentials in its caches.

## Verification

Use the isolated databases in [database checks](DATABASE.md#database-checks).
For notification checks, start the local app with fixture VAPID keys, `PUSH_ALLOWED_USER_IDS=all`, and a fixture scheduler secret.
Export the same settings for the checker.

```sh
pnpm verify:notifications
pnpm verify:monthly-reminders
```

The notification check exercises HTTP routes, database transactions, and simulated transport failures.
Its `--probe-group-balances`, `--probe-account-switch`, `--probe-device-cap`, and `--probe-message` options select focused checks.
`--keep` retains private local fixtures for browser checks.
The monthly check tests eligibility, concurrent calls, retries, and unchanged financial checksums.
With fixture VAPID keys, it uses simulated delivery.
Keep these checks local; `--hosted` is a separate, explicit Vercel fixture mode.

For monthly browser checks, retain fixtures, start the same database's app, and run:

```sh
MONTHLY_REMINDER_EVIDENCE_DIR=/absolute/path/outside/checkout pnpm exec tsx scripts/verify-monthly-reminder-ui.ts
```

It defaults to `http://localhost:3476`; `SPLITWISEST_BASE_URL` overrides that origin.
For inbox accessibility, sign in to retained notification fixtures in an isolated browser session, then run:

```sh
AGENT_BROWSER_SESSION=<owned-session> node scripts/verify-notification-read-state.mjs
```

That check changes and restores one entry's read state and checks its accessible name.
On a physical phone, enable alerts, send a foreground test, then use Test in 15 seconds and leave the app.
Observe the background alert and tap it to confirm its destination.
Repeat with a fixture expense and message from another test account.
Browser emulation and provider receipts do not replace this device check.
