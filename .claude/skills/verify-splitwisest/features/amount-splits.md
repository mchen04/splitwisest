# Exact amounts and percentages

Exact amounts assign money directly. Percentages must total 100 before an expense can be saved.

## Sub-features

- `exact-comma` accepts a comma decimal when assigning exact amounts.
- `percentage-total` rejects totals above 100.
- `shares-explicit` preserves explicitly entered weights.

## How to get to it (user POV)

- Open a group and choose `Add expense`.
- Choose `Exact amounts` or `Percentages` in the split method controls.
- The global `Add expense` action opens the same methods after group selection.

## Driving it with Playwright

Preconditions:

- Launch and doctor pass. The command creates Ann, Ben, Cat, and a USD group.

- **Run.** Execute `.claude/skills/verify-splitwisest/scripts/control.mjs drive all`.
- **Percentages.** The harness fills the amount with 10 and selects Ben and Cat. `Percentages for Ben` is 50 and `Percentages for Cat` is 50.0009. `Add expense` must be disabled.
- **Valid percentages.** Changing Cat to 50 enables saving; this check cancels without saving.
- **Exact amounts.** `Exact amounts for Cat` is 6.67 and `Exact amounts for Ben` is `3,33`. The saved shares are 667 and 333 cents.
- **Explicit Shares.** Cat gets 2 and Ben gets 1. USD 10 saves 667 and 333 cents.
- **Proof.** Require the corresponding PASS lines and exit 0 in `drive-all.log`.
- **Alternate entry.** Global group selection needs a separate browser run; the automated command covers the group action only.

## Gotchas

- Exact and percentage blank inputs keep their existing zero meaning.
- Percentage validity uses its full precision, not its rounded displayed total.
- The percentage check proves button state; it does not claim a percentage save round-trip.
- Each saved fixture is deleted, and final cleanup checks the group and user rows.
