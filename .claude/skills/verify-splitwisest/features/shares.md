# Shares

Shares divides an expense by relative weights. An untouched box shows one share and counts as one share.

## Sub-features

- `shares-blank` saves 2/blank/blank as 2/1/1.
- `shares-total` includes untouched boxes in the live total.
- `shares-equal` assigns equal weights when all selected boxes are blank.
- `shares-rounding` preserves whole-yen totals.

## How to get to it (user POV)

- Open a group, use the bottom `Add expense` action, then choose `Shares`.
- In an empty group, the main panel also has an `Add expense` button.
- Use the global `Add expense` action, choose a group, then `Shares`.
- Open an existing Shares expense and choose `Edit`.

## Driving it with Playwright

Preconditions:

- Launch and doctor pass. Drive creates three fresh members and two groups.
- No earlier expense contributes to these groups' balances.

- **Create.** Run `.claude/skills/verify-splitwisest/scripts/control.mjs drive shares`. The group journey opens `button[aria-label="Add expense"]`, then selects `radio[name="Shares"]` through `getByRole`, checks Ann, Ben, and Cat, then fills `Shares for Ann` with `2`.
- **Preview.** The USD dialog shows `40.00`, two empty inputs with placeholder `1`, and `4 total shares`.
- **Save.** The form's `Add expense` button saves 2000/1000/1000 cents. Raw weights are 2/1/1.
- **Round.** The JPY journey saves 101 yen as 51/25/25 yen. Every stored amount is divisible by 100 internal cents.
- **Equal weights.** Clearing all three boxes shows `3 total shares`. USD 30 divides 10/10/10. JPY 100 divides 34/33/33.
- **Other entry points.** Use home-page `Add expense` in a separately seeded authenticated browser; choose the group before repeating the same dialog actions. This entry is not covered by the command.
- **Proof.** Inspect `after-form.png`, `yen-form.png`, and `money-form-proof.json` in the external evidence directory.

## Gotchas

- Empty and explicitly typed `0` differ. Zero keeps zero weight.
- Decimal weights keep their meaning. The regression test checks 0/0.5/1.5.
- JPY uses integer yen while storage uses cents. 51 yen is 5100 internal cents.
- The edit journey is also defined in [Edit and reload](edit.md).
- Missing members or a missing group must fail fixture setup.
