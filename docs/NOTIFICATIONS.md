# Notifications

The inbox lives at `/notifications`. Phone preferences and device controls live at
`/settings#notifications`. Desktop navigation and the mobile Home bell open the inbox.
The mobile Home badge counts unread notifications. Existing Chat and Balances badges remain.

## Event policy

| Events | Recipients | Phone preference | Opens |
|---|---|---|---|
| Expense added, edited, deleted; receipt added or removed | Current group members, except actor | Expenses and receipts | Expense, or group activity if deleted |
| Recurring rule created, updated, stopped | Current group members, except actor | Expenses and receipts | Group activity |
| Recurring expense materialized; invalid rule paused | Current group members, including owner | Expenses and receipts | Expense or group activity |
| Group payment recorded, updated, deleted | Current group members, except actor | Payments and group balances | Group balances |
| Direct payment recorded, updated, deleted | Other payment participant | Payments and group balances | Balances |
| Group balance added, edited, deleted | Current group members, except actor, including members without an allocation | Payments and group balances | Group balances |
| Expense comment | Current group members, except author | Expense comments | Expense |
| Group message | Current group members, except sender | Group and direct messages | Group chat |
| Direct message | Other current friend | Group and direct messages | Direct chat |
| New or refreshed reminder | Named recipient | Settle-up reminders | Balances |
| Monthly settle-up reminder | Active users with an outstanding balance in that scope | Settle-up reminders | The group's Balances tab, or Balances for direct balances |
| Group joined or renamed | Current group members, except actor | Group changes | Group activity |
| Member leaves or is removed | Remaining members, except actor; removed member if someone else removes them | Group changes | Group activity or Groups |
| Group deleted | Previous members, except creator | Group changes | Groups |
| Friend request | Request recipient | Friends and requests | Balances |
| Friend accepted or removed | Other party | Friends and requests | Balances |
| Signup through a personal invite | Inviter | Friends and requests | Balances |
| Signup through a group invite | Existing members through the group-joined event | Group changes | Group activity |
| Device test | Only the selected device in the current session | Explicit test bypasses category mute | Test confirmation in inbox |

Notifications start when the schema is installed. There is no historical backfill.
Turning a phone preference off keeps inbox entries. Turning it on does not send past activity.
Payments and group balances share the existing `settlements` preference key.
Group balance alerts say Group balance added, Group balance changed, or Group balance deleted.
All three open `/groups/{id}?tab=balances`. Failed writes, version conflicts, and idempotent create
retries emit no extra notifications. Financial allocations and group balance behavior stay unchanged.
Group notifications become inaccessible after membership ends. Deleted groups remove old scoped
entries and retain a separate deletion notice. Deleted expenses open group activity.

Reading chat also marks its message notifications read. Dismissing reminders or resolving friend
requests marks their notifications read. Other inbox items have explicit read and unread controls.
Each inbox link includes Read or Unread in its accessible name.
Mark all read uses the visible newest ID, so a later arrival stays unread. Inbox entries expire after 90 days.

Intentional exclusions: your own manual changes; group creation with no other members; ordinary
signup; declined or cancelled friend requests; profile, password, recovery-code, session, theme,
category, export, filter, and read-state changes. These actions do not create activity alerts.
Notifications are not security-login alerts, email, SMS, or payment transfers.
Recurring expenses keep their existing on-view materialization schedule. No new due-date scheduler runs.
Receipt and recurring system events now also appear in the existing activity feed.
Personal-invite signups also appear in the inviter's activity feed.
A recurring rule pauses when its payer or a participant is no longer a group member.
Valid rules still materialize after their creator leaves.

## Monthly settle-up reminders

The existing delivery endpoint creates monthly reminders before sending queued phone alerts.
It runs on the first day of each month from 17:00 through 23:59:59 UTC.
The app has no saved user timezone. Business dates use UTC, and the daily cron already runs at 17:00 UTC.
That time is 09:00 Pacific in winter and 10:00 Pacific in summer.
The daily Vercel call can start within the 17:00 UTC hour. More frequent retry calls can create reminders at 17:00.
Late runs on the same UTC day still qualify. Runs on later days do not backfill missed months.

Each active user receives one inbox entry per outstanding group and one entry for all outstanding direct balances.
Both debtors and creditors qualify. A group qualifies when the user's current `group_balance_rows` net is nonzero.
This includes expenses, group balance allocations, and recorded group payments. Current membership controls access.
Direct balances qualify when a current friend's payment net is nonzero in at least one currency.
Different groups, friends, and currencies do not cancel each other's obligations.
Zero balances, fully settled scopes, deleted accounts, and inaccessible direct balances do not qualify.
Recurring expenses qualify only after the app's existing materialization has recorded them.

The title is **Monthly settle-up reminder**. The group body names the group and opens its Balances tab.
The direct body asks the user to open Balances. These are automatic SplitWisest notices with no person as sender.
They do not create nudges, activity entries, payments, or settlements.

The existing `reminders` preference covers both manual nudges and monthly reminders.
Its default is on, as is the existing global `pushEnabled` preference. These preferences control phone alerts only.
Missing preference values follow those defaults. A false `reminders` value or false `pushEnabled` suppresses phone jobs.
The inbox still receives the reminder. Phone alerts require an enrolled device with a valid session and the deployment allowlist.
The existing restricted production push rollout remains in force. This feature does not expand it.
Turning a preference on, or enrolling a device later, does not send an earlier reminder.
Delivery rechecks preferences, access, and the scope's outstanding balance. A balance settled before a retry suppresses its phone alert.
The existing inbox entry remains readable. Phone text continues to hide names, amounts, and financial details.

The unique `(user_id, event_key)` index prevents duplicate inbox entries during concurrent calls and response-loss retries.
Keys include the UTC month and group ID, or the direct scope. The inbox insert and outbox trigger share one transaction.
Phone delivery retains the existing lease, backoff, expiry, and provider-acceptance limits described below.
No schema migration, financial update, historical backfill, or new scheduler registration is needed.
Rollback restores the previous app revision. Keep financial data and existing inbox entries.

## Delivery and privacy

Database triggers write the inbox and per-device outbox in the same transaction as the event.
Failed business writes produce no notifications. Recipients are recorded at event time, never
reconstructed from a later membership list. A successful application request attempts delivery after
its response. Opening a group page also attempts delivery. Scheduled runs retry when no app is open.

The sender claims up to 24 jobs with row locks and two-minute leases. Four sends run at once.
Network errors, 429, and 5xx retry with backoff from one minute to one hour. Retry-After is respected
up to one hour. After eight attempts, a job fails. Jobs older than 24 hours are skipped. 404/410
remove expired subscriptions. Other 4xx fail without deleting a working device. A crashed worker's
lease expires and becomes claimable. Exactly-once receipt cannot be guaranteed across a process
crash after provider acceptance. Stable notification tags reduce duplicates on supporting platforms.

Each send rechecks recipient ownership, session validity, group or friendship access, read state,
preferences, VAPID key, and the deployment recipient allowlist. The subscription follows its session:
logout and session revocation remove it.
Successful login, signup, or recovery replaces this browser's session and removes its previous subscription.
Rejected authentication leaves the current session intact. Password recovery also revokes the recovered account's other sessions.
Session expiry stops sends.
Log in and turn notifications on again after expiry. Remote device removal stays off until a new tap.
Key rotation requires reconnecting the device. Each account supports up to ten subscriptions with unexpired sessions.
Enrollment removes expired-session subscriptions before applying that limit.

Push content always identifies SplitWisest and says there is new activity. It never includes names,
amounts, expense titles, or message text. Details require authenticated access inside the app.
The service worker shows every received push, including in the foreground. Taps open an authenticated,
same-origin notification route. Login preserves that destination. No API responses or push credentials
are stored by the service worker. Inbox reads do not enter the persistent client read cache.

Only known Apple, Google, Mozilla, and Windows push-provider HTTPS endpoints are accepted.
Redirects are refused. API responses and delivery receipts omit endpoint secrets and provider bodies.

## Setup and rollout

Keep the existing database provider. Run the additive notification migration before this app version:

```sh
# Supply DATABASE_URL securely through the process environment.
pnpm migrate:notifications
```

For a new empty fixture database, first run `pnpm tsx scripts/migrate.ts`. Do not rerun the broad
bootstrap migration against production for this feature. The dedicated migration uses one transaction,
creates four tables and seven triggers, and reads their presence back. Rerunning it does not backfill events.
It uses the row guard described in DATABASE.md: it snapshots `schema_migrations`, the only existing
table it writes, and fails if an existing row there changes.

Generate VAPID keys with `web-push.generateVAPIDKeys()` in a private setup script. Store the keys directly
in the deployment's environment store. Never put the private key in a client-prefixed variable or logs.

| Variable | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | Generated public key |
| `VAPID_PRIVATE_KEY` | Matching server-only private key |
| `VAPID_SUBJECT` | Operator HTTPS contact URL or mailto URI; do not use localhost for Safari |
| `PUSH_ALLOWED_USER_IDS` | Comma-separated approved test IDs; empty disables delivery; `all` is the later opt-in rollout |
| `PUSH_CRON_SECRET` | At least 32 random characters, shared only with the schedulers |
| `CRON_SECRET` | Production only; the same value as `PUSH_CRON_SECRET`. Vercel Cron sends it as the bearer token |

Three schedulers call `/api/notifications/deliver` with the same bearer secret:

- **Vercel Cron** (`vercel.json`) sends a GET once a day at 17:00 UTC. Vercel can start it any time in
  that hour. This is the guaranteed run. The Hobby plan allows one run per day for each cron job; a
  more frequent expression fails the deployment. Vercel runs crons only for the production deployment.
- **GitHub Actions** (`.github/workflows/notification-delivery.yml`) asks for a POST every five minutes.
  GitHub treats schedules as best effort. In October 2026 it ran about every five hours. Treat it as
  extra retries, not as a deadline.

- **Hermes** (Michael's always-on Mac, job "Splitwisest push retries") POSTs every ten minutes with
  the same secret, read from `~/.config/splitwisest/push-cron-secret` (mode 600). It is silent on
  success and alerts the operations channel on any non-200 or failed delivery. This is the frequent
  trigger while the Mac is up.

Delivery skips jobs older than 24 hours. If the Mac is down and GitHub skips its runs, a failed push
can wait for the daily Vercel run and may expire first. A guarantee that does not depend on the Mac
needs Vercel Pro (per-minute cron) or a Cloudflare Worker cron trigger that POSTs with the same secret.

To rotate the secret, change `PUSH_CRON_SECRET` and `CRON_SECRET` in Vercel production, the GitHub
secret `PUSH_CRON_SECRET` and the Hermes secret file together, then redeploy. Set repository secret `PUSH_DELIVERY_URL` to the complete
production HTTPS endpoint. This public repository uses standard GitHub-hosted runners. Do not move
the schedule to a paid/private runner without a new cost decision.

Manual runs use POST with the same secret. Each run returns and logs (`event: notification-delivery`,
`trigger: vercel-cron` or `manual`) the counts of provider acceptance, retries, expired devices,
skipped events, and failures. Provider acceptance is not proof that a device displayed an alert.
The `remindersCreated` receipt counts newly inserted monthly inbox entries across all eligible scopes.
Unauthenticated calls get 401.

A preview has no scheduler. Use manual POSTs with the preview's own secret.

This release has completed independent review. Michael waives native Safari and physical-iPhone
receipt, background delivery, and tap-through checks. Both remain **WAIVED/UNVERIFIED**, not passed.
These waivers do not replace software checks or actual hosted delivery evidence. Record manual workflow
runs and naturally scheduled runs separately; configuration and a Mac retry loop do not prove either.

Production push delivery starts with an explicit allowlist of controlled test accounts. Accounts outside
that list retain the inbox but cannot enroll for phone alerts. This is a restricted rollout, not push
availability for every account. Do not infer a production identity from a preview account ID.

## Platforms and acceptance

Push needs HTTPS and a production build with a registered service worker. On iPhone and iPad, install
the Home Screen app on iOS/iPadOS 16.4 or later. A Safari tab cannot receive these phone alerts.
Safari on macOS 13 with Safari 16 or later, current Chrome/Edge, and current Firefox support standards
Web Push subject to browser policy. Unsupported browsers, private modes, blocked permissions, offline
devices, OS Focus settings, and battery restrictions can prevent or delay receipt. The inbox still works
online. Push enrollment is intentionally unavailable in the development server, which unregisters workers.

The following device procedure remains a reference for future testing; it does not block this waived release.
For each physical test device, sign in, open Notifications settings, and tap Turn on notifications.
Accept the OS prompt. Use Send test while the app is foregrounded. Then use Test in 15 seconds,
leave the app, observe the background alert, and tap it. Confirm the test-opened banner. Repeat with
a fixture expense and a fixture message from the other test account. Confirm the precise destination.
Then turn off the device and send another fixture event; it must remain in the inbox without an alert.
Capture only test data. Never label emulation, a provider ticket, or a screenshot as physical receipt.

## Verification

```sh
pnpm vitest run
pnpm exec tsc --noEmit
pnpm lint
pnpm verify:ui-tokens
pnpm build
node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/verify-monthly-reminders.ts
# Isolated local Postgres + Neon HTTP proxy, described in DATABASE.md:
node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/verify-notifications.ts
```

The executable suite refuses remote databases and any local database except
`splitwisest_notifications_qa`. It creates test accounts, exercises real HTTP routes and database
transactions, injects a sender for deterministic transport failures, and cleans up its own fixtures.
`--keep` retains fixtures for browser checks and writes credentials only to a gitignored private file.
`--probe-message` is the narrow oracle for a disabled-message-trigger negative control.
`--probe-account-switch` checks session replacement through login, signup, and recovery.
`--probe-device-cap` checks expired devices, concurrent enrollment, and subscription refresh at the limit.
`--probe-group-balances` checks group balance recipients, preference muting, destinations, idempotency,
conflicts, rollback, and membership visibility through real HTTP routes and database transactions.

The monthly suite uses its own empty `splitwisest_monthly_qa` database with the same local proxy.
It tests scope eligibility, preferences, real SQL concurrency, delivery leases, transient retries, and unchanged financial checksums.
It uses an injected push transport. It does not prove provider acceptance or physical receipt.
Its `--keep` option retains private local fixtures for desktop/mobile browser navigation checks.
Its `--hosted` option permits an explicit Vercel runtime/build check against controlled fixtures only.
That check uses platform secrets inside Vercel, scopes every reminder and send to its newly created accounts, and removes its fixtures.
It preserves sanitized schema readback and financial counts/checksums in its output. It never reads secret values into evidence.
Hosted fixture execution does not prove a natural first-of-month firing.
For retained local fixtures, verify actual desktop/mobile links with:

```sh
MONTHLY_REMINDER_EVIDENCE_DIR=/absolute/path/outside/checkout pnpm tsx scripts/verify-monthly-reminder-ui.ts
```

This uses the local production build on port 3476. It covers inbox rendering, balance navigation, read state, and the existing reminder preference.
Chromium mobile emulation does not prove Safari or physical phone receipt.

For the browser regression, sign into a retained local fixture using an isolated `agent-browser` session.
Open `/notifications`, then run:

```sh
AGENT_BROWSER_SESSION=<owned-session> node scripts/verify-notification-read-state.mjs
```

The check toggles a notification's read state and restores its original state.
It checks the link's accessible name in both states. It does not prove screen-reader speech or physical-device receipt.
Close the task-created browser session after the check.

The starting reference is [Pancake PR 74](https://github.com/jormyy/pancake/pull/74), at
`b413c17cb6db43e43bea2d6ec4fb9d7195ebef88`. Its client, encryption, and delivery suites are reproduced
before adaptation. SplitWisest uses the Node web-push package, durable retries, and session-bound
ownership in place of the reference's custom crypto and best-effort fanout.

Primary platform references: [Apple Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers),
[Home Screen requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
[Next.js after](https://nextjs.org/docs/app/api-reference/functions/after), and
[Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).
