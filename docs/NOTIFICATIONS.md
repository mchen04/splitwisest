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
| Group payment recorded, updated, deleted | Current group members, except actor | Recorded payments | Group balances |
| Direct payment recorded, updated, deleted | Other payment participant | Recorded payments | Balances |
| Expense comment | Current group members, except author | Expense comments | Expense |
| Group message | Current group members, except sender | Group and direct messages | Group chat |
| Direct message | Other current friend | Group and direct messages | Direct chat |
| New or refreshed reminder | Named recipient | Settle-up reminders | Balances |
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
Group notifications become inaccessible after membership ends. Deleted groups remove old scoped
entries and retain a separate deletion notice. Deleted expenses open group activity.

Reading chat also marks its message notifications read. Dismissing reminders or resolving friend
requests marks their notifications read. Other inbox items have explicit read and unread controls.
Each inbox link includes Read or Unread in its accessible name.
Mark all read uses the visible newest ID, so a later arrival stays unread. Inbox entries expire after 90 days.

Intentional exclusions: your own manual changes; group creation with no other members; ordinary
signup; declined or cancelled friend requests; profile, password, recovery-code, session, theme,
category, export, filter, and read-state changes. These actions do not create activity alerts.
Notifications are not security-login alerts, email, SMS, payment transfers, or scheduled debt chasing.
Recurring expenses keep their existing on-view materialization schedule. No new due-date scheduler runs.
Receipt and recurring system events now also appear in the existing activity feed.
Personal-invite signups also appear in the inviter's activity feed.
A recurring rule pauses when its payer or a participant is no longer a group member.
Valid rules still materialize after their creator leaves.

## Delivery and privacy

Database triggers write the inbox and per-device outbox in the same transaction as the event.
Failed business writes produce no notifications. Recipients are recorded at event time, never
reconstructed from a later membership list. A successful application request attempts delivery after
its response. A separate scheduler retries when no app is open.

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

Generate VAPID keys with `web-push.generateVAPIDKeys()` in a private setup script. Store the keys directly
in the deployment's environment store. Never put the private key in a client-prefixed variable or logs.

| Variable | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | Generated public key |
| `VAPID_PRIVATE_KEY` | Matching server-only private key |
| `VAPID_SUBJECT` | Operator HTTPS contact URL or mailto URI; do not use localhost for Safari |
| `PUSH_ALLOWED_USER_IDS` | Comma-separated approved test IDs; empty disables delivery; `all` is the later opt-in rollout |
| `PUSH_CRON_SECRET` | At least 32 random characters, shared only with the scheduler |

The GitHub workflow calls `/api/notifications/deliver` with a bearer secret every five minutes.
Set repository secrets `PUSH_DELIVERY_URL` (the complete HTTPS endpoint) and `PUSH_CRON_SECRET` only for
the intended deployment. This public repository uses standard GitHub-hosted runners. Do not move
the schedule to a paid/private runner without a new cost decision. GitHub schedules run on the default
branch and can be delayed; they do not promise a delivery deadline. The endpoint also supports manual
POSTs using the same secret. It returns counts of provider acceptance, retries, expired devices,
skipped events, and failures. Provider acceptance is not proof that a device displayed an alert.

Vercel Hobby only supports daily cron jobs, so it is not used for this retry interval.
A preview must have its own scheduler or a controlled temporary runner; deploying this branch does not
activate the GitHub schedule. Production rollout waits for independent review and device verification.

## Platforms and acceptance

Push needs HTTPS and a production build with a registered service worker. On iPhone and iPad, install
the Home Screen app on iOS/iPadOS 16.4 or later. A Safari tab cannot receive these phone alerts.
Safari on macOS 13 with Safari 16 or later, current Chrome/Edge, and current Firefox support standards
Web Push subject to browser policy. Unsupported browsers, private modes, blocked permissions, offline
devices, OS Focus settings, and battery restrictions can prevent or delay receipt. The inbox still works
online. Push enrollment is intentionally unavailable in the development server, which unregisters workers.

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
