# Edit and reload

Editing a Shares expense preserves its weights and recomputes its allocation when the amount changes.

## Sub-features

- `edit-unchanged` saves 2/1/1 without changing amounts.
- `edit-amount` recomputes shares after changing the total.
- `edit-reload` reopens persisted values after reloading the page.

## How to get to it (user POV)

- In a group's Expenses tab, select the expense row, then `Edit`.
- In the global Expenses page, select the expense link, then `Edit` in the group dialog.
- Open `/groups/<group id>?expense=<expense id>` and choose `Edit`.

## Driving it with Playwright

Preconditions:

- Launch and doctor pass. The command first saves a Shares expense through the group form.

- **Run.** Execute `.claude/skills/verify-splitwisest/scripts/control.mjs drive shares`.
- **Open.** The command clicks `View USD proportional shares`, then `Edit`.
- **Read.** The `Edit expense` dialog shows `Shares for Ann` as 2 and Ben and Cat as 1.
- **Save unchanged.** Click `Save changes`, reload, and reopen. Stored cents remain 2000/1000/1000 and inputs remain 2/1/1.
- **Change amount.** Enter 48 in `#expense-amount`, save, and reload. USD allocation becomes 2400/1200/1200.
- **Yen.** The same edit changes 101 to 103 yen. Allocation becomes 51/26/26 yen and preserves the full amount.
- **Proof.** Inspect `after-edit-reload.png`, `yen-edit-reload.png`, and the unchanged/changed records in `money-form-proof.json`.
- **Alternate entries.** The global Expenses link and direct expense URL need separate browser coverage. They are not claimed by the group-row command.

## Gotchas

- Wait for the saved input values; the modal can appear before its expense loads.
- A successful PATCH alone does not prove persistence. Reload and read the values again.
- Stale edit versions can be rejected. The fixture run uses its own groups and has no competing editor.
