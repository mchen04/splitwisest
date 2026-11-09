---
name: verify-splitwisest
description: Verify Splitwisest's real web expense forms, Shares allocations, edits, and balances with local PostgreSQL and headless Chromium. Use after money-form changes or when reproducing expense split bugs.
---

# Verify Splitwisest

Run from this checkout's root. Read [the feature map](features/README.md) and the selected feature first.
The primary surface is the Next.js web app. HTTP and SQL reads confirm its stored results.
Use local fixtures only. Never use production, remote databases, or the user's browser.

## Launch

Prerequisites are Node, pnpm, Docker Desktop, installed lockfile dependencies, and an existing Chromium executable.
This checkout uses PostgreSQL on 55433, its HTTP proxy on 54444, and Next on 3391.
The helper finds Docker inside `/Applications/Docker.app` when needed.

```sh
export SPLITWISEST_CHROMIUM_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell"
.claude/skills/verify-splitwisest/scripts/control.mjs launch
```

Launch runs `pnpm db:local`, creates `splitwisest_money_qa` if absent, and applies base and notification migrations there.
It starts `next dev` with that database and waits for the expected build identity and migrated tables.
An empty database needs no manual seeding. Drive creates Ann, Ben, Cat, and USD/JPY groups through public app APIs.
`PASS doctor` means the app is ready for fixture creation and browser driving.

Use `http://localhost:3391`. Opening Next through `127.0.0.1` can block its browser JavaScript.
An occupied app port, existing instance record, or checkout dev lock stops launch.
Do not reuse that instance or remove its lock. Finish the owning run first.
Different checkouts require distinct `SPLITWISEST_VERIFY_PORT`, `SPLITWISEST_PG_PORT`, and `SPLITWISEST_PROXY_PORT` values.
Two dev servers cannot safely share this checkout's `.next` directory.
The helper stores its server PID and process start time outside the repo.

## Doctor

```sh
.claude/skills/verify-splitwisest/scripts/control.mjs doctor
```

This read-only check verifies the recorded process, expected `/api/version`, dedicated database, and required schema.
It rejects a different app build or a missing schema. Run it whenever a browser result looks wrong.
Drive also proves the app and SQL target match using a temporary session that it deletes.

## Drive

```sh
.claude/skills/verify-splitwisest/scripts/control.mjs drive shares
.claude/skills/verify-splitwisest/scripts/control.mjs drive all
```

`shares` runs USD and JPY creation, balances, unchanged edits, changed totals, reloads, and equal blank weights.
`all` adds the existing itemized, percentage, exact-amount, and explicit Shares checks.
Both call `scripts/verify-money-form.ts` with a new headless browser and synthetic accounts.
They need no ledger run or previous account password.
The executable path override avoids downloading Chromium or changing shared caches.

The Shares route is `/groups/<fixture id>`.
The harness clicks the bottom `button[aria-label="Add expense"]`, scopes to the `Add expense` dialog, and selects the `Shares` radio.
It fills `#expense-amount`, `Description`, and `Shares for Ann`; Ben and Cat stay empty.
It checks `4 total shares`, then uses the form's `Add expense` button to submit.
It opens `Balances`, checks each debtor's `Record payment: <name> pays Ann` row, and reads the group API and SQL balances.
Edits start at `View USD proportional shares`, then `Edit`, and finish through `Save changes`.
Do not replace those writes with API expense creation or internal setters when proving Shares.

## Evidence

The helper stores proof files under `~/.cache/splitwisest/verify-<checkout hash>/evidence/` by default.
Set `SPLITWISEST_VERIFY_DIR` to override the parent directory.

- `after-form.png` and `.aria.txt` show 2 plus two empty boxes and four total shares.
- `after-saved.png` and `.aria.txt` show the saved USD expense.
- `after-balances.png` and `.aria.txt` show Ben and Cat each owing Ann $10.
- `after-edit-reload.png` and `.aria.txt` show the reopened 2/1/1 weights after an unchanged save and reload.
- `yen-*.png` and `.aria.txt` show the corresponding whole-yen journey.
- `money-form-proof.json` records allocations, raw weights, API nets, SQL nets, and fixture cleanup.
- `drive-shares.log` or `drive-all.log` records the checks and command exit code.
- `server.log` records app startup and requests.

Require screenshots of the action and result, successful API reads, and matching SQL balances.
USD $40 must allocate 2000/1000/1000 cents with nets 2000/-1000/-1000.
JPY 101 must allocate 5100/2500/2500 internal cents, all divisible by 100.
Equal JPY weights must preserve the total despite rounding.
Open screenshots before claiming visual proof. A screenshot alone does not prove persistence.
An unmet precondition is a failed journey. Record it; do not weaken assertions or silently skip an entry point.

## Cleanup

Drive closes its browser and deletes only its own fixture groups and users, even after assertion failures.
It verifies those rows are gone and writes the cleanup result into the proof file.
Always run this command after a successful or failed attempt:

```sh
.claude/skills/verify-splitwisest/scripts/control.mjs cleanup
```

Cleanup stops only the recorded process group after checking its PID and start time.
It drops the dedicated database only when this launch created it, closing that database's proxy connections.
An existing dedicated database and the checkout's Docker containers remain running.
Never use `db:local:down` here or stop other projects' containers.
Cleanup removes the instance record and keeps the evidence directory.
Require `5/5 proof artifacts retained` after a completed Shares drive.
For interrupted drives, inspect the failure log; cleanup is not proof of a successful journey.

## Helpers

The executable helper is `scripts/control.mjs` relative to this skill.
Its four invocations are shown above. `drive` defaults to `shares`.
The underlying harness can also run against an already owned instance:

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/splitwisest_money_qa \
NEON_LOCAL_PROXY=http://127.0.0.1:54444/sql \
SPLITWISEST_BROWSER_URL=http://localhost:3391 \
SPLITWISEST_EVIDENCE_DIR="$HOME/.cache/splitwisest/money-form/evidence" \
SPLITWISEST_MONEY_FORM_FEATURE=shares \
pnpm exec tsx scripts/verify-money-form.ts
```

Keep `SPLITWISEST_CHROMIUM_PATH` exported for this command.
Do not run `pnpm build` or the full suite on this Mac.
For money-form changes, run `share-input.test.ts`, `money.test.ts`, `money-invariants.test.ts`, `tsc --noEmit`, and `pnpm lint`.
Use `/maintain-verification-skill` when routes, controls, or money rules change.
