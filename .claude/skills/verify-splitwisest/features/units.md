# Custom units

A group can track nonmonetary units such as drinks, chores, or points beside money.
A unit belongs to one group. Its name is trimmed and unique within the group, ignoring case.
The same name in another group is a different unit. Units never convert or add to money or to each other.
Quantities are stored in hundredths in the existing amount columns, so splits stay exact.

## Sub-features

- Add expense defaults to Money. The `Money` and `Custom unit` radios switch denomination.
- `Custom unit` shows the group's units and a `New unit` path. Creating an existing name returns that unit.
- Changing the expense's group clears a custom unit and keeps the other fields.
- Each unit has its own Balances card titled with the unit name and `simplified` or `not simplified`.
- Group settings lists units with rename and delete. Delete works only for unused units.
- Group settings has the auto-reconcile checkbox, `Simplify unit balances`. New and existing groups start on.
- Simplify on: members' unit nets cancel and simplify like money, within one unit only.
- Simplify off: each participant owes the payer their share. Opposite debts stay as two rows, even when equal.
- A recorded unit repayment reduces only the payer's debt to that recipient in that unit.
- With simplify off, a repayment above the outstanding debt fails with a message and writes nothing.
- Historic excess from repayments made while simplify was on shows as the recipient owing the payer.
- A member cannot leave or be removed while any unit balance involving them is unsettled.
- Friend and people pages show units on separate lines. Their money settle actions ignore unit debts.
- CSV export appends unit columns after the existing money columns.
- Monetary-only actions are unavailable for units: currency choice, conversion, and direct friend payments.

## How to get to it (user POV)

Open a group, press the bottom `Add expense` button on phones or the sidebar button on desktop, and choose `Custom unit`.
Open the `Balances` tab to see each unit card and its `Record` buttons.
Open the group menu (`Group menu`), then `Group settings`, for units and the simplify checkbox.

## Driving it with the helper

Run `control.mjs drive units` after `launch` and `doctor`.
It needs `PLAYWRIGHT_BROWSERS_PATH` pointing at a folder with the lockfile's WebKit build.
Install one there with `PLAYWRIGHT_BROWSERS_PATH=<folder> pnpm exec playwright-core install webkit`, never into a shared cache.

`scripts/verify-units.ts` drives the HTTP API and reads SQL. It prints one PASS or FAIL line per check and a JSON summary.
It proves money nets, suggestions, insights, export totals, and friend balances stay identical after unit data is added.
It also covers forged cross-group unit ids, concurrent duplicate creates, the concurrent over-repayment race, and query counts.

`scripts/verify-units-ui.mjs` drives WebKit at 320, 390, and 393 wide in standalone mode, at 1280 desktop, in dark mode, and with larger text.
`UNITS_UI_ONLY=<label>` runs one flow, such as `390` or `320`.
It asserts no horizontal overflow, accessible names, focus return, and a reachable sticky footer.
Screenshots go to `<evidence>/units-ui/<width>-<step>.png`.

End state that proves the feature:
- The API summary reports zero failures.
- The `390-balances.png` screenshot shows the Balances tab with the unit card and its debt row.
- The settle screenshot shows the payment sheet without currency choice.
- The settings screenshot shows the simplify checkbox with its explanation.

## Gotchas

- The UI script creates its own accounts and groups through public APIs and deletes them afterwards.
- A unit name up to 40 characters must not push row amounts or sheet buttons off screen at 320 wide.
- The OFF-mode repayment check runs inside the group-locked transaction. Test it with concurrent requests, not sequential ones.
- Run the WebKit matrix and the full suite on the compute machine, not on the coding Mac.

## Stale read-cache upgrade

Persisted reads live in `localStorage["splitwisest.read-cache.v1"]` as `{ owner, build, entries }`.
`build` is `NEXT_PUBLIC_BUILD_ID`. Hydration discards the whole entry when the build is missing or differs, or when the owner cookie differs.
The cache-owner cookie, session cookie, drafts (`splitwisest.draft.*`), push device (`splitwisest.push-device`), and server notification outbox are separate and are not cleared by this check.

Run the genuine two-build upgrade on the compute machine:

```sh
node scripts/pwa-swap-harness.mjs build --old-ref 4b2480f
node scripts/pwa-swap-harness.mjs suite --scenario units-cache
```

The harness builds `4b2480f` as A in a temporary git worktree and this tree as B, serves both on one local HTTPS origin, signs in on A, opens a money group, swaps to B, then checks the stale entry, cold launch, worker update, resume, and reload.
Each scenario prints one JSON line and the command exits nonzero on failure.

The inverse proof builds B from the released `1c6a729` tree and must fail:

```sh
node scripts/pwa-swap-harness.mjs build --old-ref 4b2480f --new-ref 1c6a729
node scripts/pwa-swap-harness.mjs suite --scenario units-cache
```

Run stale-cache injection, account isolation, and the negative control against a running build:

```sh
SPLITWISEST_BROWSER_URL=http://localhost:3391 \
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" \
node .claude/skills/verify-splitwisest/scripts/verify-units-cache.mjs inject

SPLITWISEST_BROWSER_URL=http://localhost:3391 \
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" \
node .claude/skills/verify-splitwisest/scripts/verify-units-cache.mjs isolation

SPLITWISEST_BROWSER_URL=https://localhost:3311 \
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" \
node .claude/skills/verify-splitwisest/scripts/verify-units-cache.mjs negative
```

`inject` seeds a build-less v1 group detail and requires a fresh `/api/groups/:id` request, a rendered group, and a signed-in session.
`isolation` seeds another account's entry and requires it not to paint.
`negative` runs against the old build and passes only when the stale entry causes no fresh `/api/groups/:id` request or the crash screen, proving the check goes red on `1c6a729` behavior.
