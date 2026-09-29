Run ID: e86ee529f81c4c6494a24c1a94da7ea5
Status: complete

## Passes

One scoped cleanup pass over the diff against `ecf122176bc08ec5e536074b15efada5fd9de0f8` was committed as `cfe5ae3`. This rerun preserved it and made no further code changes.

## Rebase

Not needed; the coordinator checked ancestry.

## Removed

No files or features removed. The pass replaced repeated balance-list searches in the group balance preview with one lookup map, preserving behavior.

## Tests deleted

None. The added allocation tests have assertions that can fail on behavior changes.

## Docs updated

`docs/USAGE.md` now explains that a concurrently edited entry must be reopened to load its latest version before retrying. This report records the current run.

## Verified

The prior pass ran `git diff --check` (exit 0) and `pnpm exec vitest run src/lib/__tests__/group-obligation-math.test.ts` (exit 0; 9 tests) synchronously. This rerun relies on the coordinator's completed prechecks; no test job was started here.

## Checks

Bounded plan: coordinator base/current install, build, lint, raw `tsc --noEmit`, Vitest unit suite, and UI token check. Precheck raw exit codes were 0 for each command on both base and current. These receipts precede this report change.

Coordinator postchecks have not run yet. This rerun started no full-suite, lint, typecheck, or build job.

## Commits

`cfe5ae3` — scoped code and documentation cleanup. This commit — current-run cleanup report.

## Reverted

none
