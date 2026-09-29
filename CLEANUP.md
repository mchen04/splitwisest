Run ID: 65ca1d9cbe384e12bcec2c35bd0e05fb
Status: complete

## Passes

- One cleanup pass over the diff against `ecf122176bc08ec5e536074b15efada5fd9de0f8`. Replaced repeated balance-list searches in the group balance preview with one lookup map. Behavior is unchanged.

## Rebase

- Not needed; the coordinator checked ancestry.

## Removed

- No files or features removed.

## Tests deleted

- None. The new allocation tests contain assertions that can fail on behavior changes.

## Docs updated

- `docs/USAGE.md` now explains that a concurrently edited entry must be reopened to load its latest version before retrying.

## Verified

- `git diff --check`: exit 0.
- `pnpm exec vitest run src/lib/__tests__/group-obligation-math.test.ts`: exit 0; 9 tests passed synchronously.

## Checks

- Bounded plan: coordinator base/current build, lint, raw `tsc --noEmit`, Vitest unit suite, and UI token check. All precheck raw exit codes were 0 on both base and current; these are pre-cleanup receipts.
- Coordinator postchecks have not run yet. No full-suite, lint, typecheck, or build job was started in this cleanup pass.

## Commits

- `cfe5ae3` — scoped code and documentation cleanup.
- This commit — cleanup report.

## Reverted

- none
