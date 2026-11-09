# Add / Edit / multi-select (all apps)

Owner rule: simple, easy, less verbose. A list is a list.

## Words (buttons)
**Add** <thing> · **Edit** <thing> · **Save** · **Cancel** · **Remove**.
Never New, Create, Manage, Register, Record, "Plan a", Start on a button. One noun per thing: store, person, price list.

## List screen
search on top · list · big **Add <thing>** button · long-press multi-select with bulk actions · paging.
No KPI cards, charts or readiness % on a list; those live on dashboards.
Never show Add only after a failed search; never hide a form in an overflow menu.

## Detail screen
**Edit** top-right in the header, plus a visible "Edit <thing>" button in the body.
Remove lives inside Edit, never beside the title.

## Form
Save at the bottom; back = Cancel (ask if there are unsaved changes).

## Android kit (`ui/CalmComponents.kt`, field and van)
- `AddFab("Add store") { … }` — call inside the `Box` that holds the list. Pins bottom-end above the bottom nav,
  system bars and keyboard; min 56 dp; tag `add-fab`. Give the list `contentPadding` bottom `AddFabListPadding`.
- `val sel = rememberSelection<String>()`; rows use `Modifier.selectableRow(sel, id) { open(id) }`
  (long-press picks, tap toggles while picking).
- `SelectBar(sel.count, listOf("Remove" to { … }), onClear = sel::clear)` at the top of the list:
  "N selected", actions, Cancel; tag `select-bar`. Hidden at 0.
- Field header: `HeaderSpec(action = HeaderAction("Edit", onClick))` shows Edit top-right (tag `header-action`).
  Van: `ScreenFrame(trailing = …)`.

## Guard
`ButtonLabelLintTest` (both apps) fails on new "New …" / "Create …" / "Manage…" literals.
Existing ones are in `src/test/resources/label-lint-allowlist.txt`; lanes delete lines as they fix screens, never add.
