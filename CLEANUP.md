Run ID: c9924fe6344046779fb15c6f3780613f
Status: complete

## Passes

- One sequential pass over the diff against `ecf122176bc08ec5e536074b15efada5fd9de0f8`: clarified split input wording. No behavior changes.

## Rebase

- Not needed; the coordinator checked ancestry.

## Removed

- none

## Tests deleted

- none; the reviewed assertions can fail when validation, allocation, rounding, or sync behavior changes.

## Docs updated

- `docs/USAGE.md` now says Exact, Percentage, and Shares splits require a value for every selected person. The related unit test title uses the same distinction.

## Verified

- Compared the usage wording with the form input validation and unit test cases.
- `git diff --check` exited 0 before the scoped commit. No direct behavior check was needed for wording-only edits.

## Checks

- Bounded coordinator plan: frozen install, build, lint, raw `tsc --noEmit`, UI token check, and Vitest unit run on base and current.
- Coordinator prechecks before this pass: base/current raw exit codes were 0/0 for install, build, lint, typecheck, UI tokens, and unit tests. These are prechange receipts, not postchange results.
- Postchecks for these commits have not run yet; the coordinator owns the planned verification after this session.

## Commits

- `b8f179c` — clarified usage wording and the unit test title.
- This report is committed separately.

## Reverted

none
