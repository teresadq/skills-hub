# Admin UI Specification

A concise visual and interaction contract for dense admin systems. Applies on top of `ui-and-icons.md`; it does not replace shadcn tokens or the project theme.

## Scope

Keep only what makes admin screens consistent:

- page skeletons
- density and spacing
- table, form, chart, and state rules
- accessibility and pre-delivery checks

Do **not** add a second color system, font stack, icon set, or component library. Use the project's shadcn theme, Tailwind tokens, and Kubai icons.

## App shell

```text
App
├─ Sidebar          grouped navigation + current user
└─ Main
   ├─ Topbar        breadcrumbs / search / notifications / account
   └─ Page
      ├─ Page header       title + description + page actions
      ├─ KPI strip         optional, 3–4 cards
      ├─ Primary workspace main task
      ├─ Exception layer   risks, alerts, AI suggestions
      └─ Supporting modules
```

- Sidebar: 224px expanded, 72px collapsed; active item uses a subtle surface, not a strong fill.
- Topbar: 56–60px; keep search, notifications, and account in stable positions.
- Content max width: 1600px; data pages may use the full remaining width.
- Page padding: 24px desktop, 32px wide, 16px narrow.
- Only the page content changes between routes; the shell dimensions and component language stay fixed.

## Page skeletons

### Dashboard

1. Page header.
2. 4 KPI cards of equal height.
3. Main workspace: 8:4 or 7:5 grid.
4. Exception / AI strip: 2–3 compact items, ordered by severity.
5. Supporting modules: trend, composition, ranking.

Every module answers one question. Do not fill the first screen with eight equal cards and no actionable exception.

### List / queue

1. Page header + primary action.
2. Compact filter bar: search, status, owner, date, column settings.
3. Table is the main workspace; it must be visible in the first screen.
4. Bulk action bar appears only when rows are selected.
5. Row click opens detail; lightweight edits use a `Sheet`, not a full page jump.
6. Pagination and selection state live in the URL when shareable.

### Detail

1. Identity header: name, ID, status, key attributes, primary action.
2. Tabs: overview, activity, related records, attachments, notes.
3. Main content 8:4 or 4:8; keep the same split across similar entities.
4. Timeline / history below the main block.
5. Destructive actions separated from normal actions.

### Settings

1. Secondary navigation 200–240px on the left.
2. Form width 640–760px.
3. Group related settings; one save strategy per page (sticky footer or end-of-form).
4. Dangerous settings get their own section with explicit consequences.

### Schedule

1. 3–4 KPIs.
2. Day/week/month switch; resource filter.
3. Timeline or resource lanes as the main workspace.
4. Conflicts and pending requests visible without opening a detail page.
5. Status colors match the list and detail pages exactly.

## Density

| Element | Size |
|---|---|
| Base unit | 4px |
| Primary rhythm | 8px |
| Card padding | 16–20px |
| Card gap | 12–16px |
| Control height | 32–36px |
| Table row | 44–52px |
| Sidebar item | 36px |
| Page section gap | 20–24px |

- Use a 4/8px scale: 4, 8, 12, 16, 20, 24, 32, 40, 48.
- Prefer compact groups and scannable rows over large hero sections.
- Do not use a page title larger than a marketing hero; admin titles stay functional.
- Use whitespace and alignment for hierarchy before borders, shadows, or color blocks.

## Typography

Use the project's existing font. Do not add a second display font.

| Role | Size / line height | Weight |
|---|---|---|
| Page title | 24/32 | 600–700 |
| Section title | 16/24 | 600 |
| Card title | 14/20 | 600 |
| KPI value | 26–32/36 | 700 |
| Body | 14/22 | 400–500 |
| Table / control | 13–14/18–20 | 500 |
| Meta / helper | 12/16 | 400–500 |

- Numbers in tables and KPIs use tabular figures.
- Keep decimal places and units consistent within a column.
- Do not use font weight as the only hierarchy signal.

## Color and status

- Use semantic tokens only: `bg-background`, `bg-card`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-destructive`.
- One primary action per viewport region. Do not give every card a gradient or accent fill.
- Status colors are reserved for real status: success, info, warning, critical.
- Normal chart series must not borrow warning/critical colors for decoration.
- Status is never color-only. Pair it with text, an icon, a number, or a shape.
- Use low-saturation status backgrounds for badges; reserve strong fills for primary buttons and critical alerts.

## Tables

- Server-side pagination, sorting, and filtering for large data sets.
- Keep pagination, sort, and filters in the URL search params.
- Sticky header; row hover; clear selected state.
- Column visibility and saved views for wide tables.
- Bulk actions operate on selected rows and show the count.
- Row actions use a dropdown when there are more than two.
- Numbers right-aligned; text left-aligned; status centered only when it reads better.
- Provide loading, empty, error, and no-result states.
- Do not hide columns on mobile without a way to reach them; use horizontal scroll or a detail view.

## Forms

- `FieldGroup` + `Field` + `FieldLabel` + control + `FieldError`.
- Labels above controls; helper text below; errors inline.
- Mark optional fields instead of marking every required field.
- Validate on blur and submit; avoid validating on every keystroke unless the field needs it.
- Map server `422` field errors back to the matching field.
- Disable submit while pending and show a `Spinner`; do not only change the label.
- Keep destructive actions away from the primary submit button.
- Use a `Sheet` for lightweight create/edit; use a page for long multi-section forms.

## Charts

One chart answers one question.

| Question | Use | Avoid |
|---|---|---|
| Change over time | line / area | pie, unordered bars |
| Compare discrete periods | grouped bar | smoothed line implying continuity |
| Composition of a total | stacked bar / 100% bar | stacking unrelated metrics |
| Ranking or capacity | horizontal bar | pie with many slices |
| Single progress | ring KPI / progress bar | decorative gauges |
| Schedule | calendar / timeline | line chart for bookable dates |
| Process stages | timeline | plain list hiding order |
| Distribution | histogram / box plot | bars treating intervals as categories |
| Two variables | scatter | bubble size without meaning |

Rules:

- No dual axes.
- No 3D charts, rainbow scales, or decorative risk colors.
- Show title, time range, unit, legend or direct labels.
- Include loading, empty, error, and partial-data states.
- Provide a text summary or data-table fallback.
- Use the project's chart primitives (shadcn Chart / Recharts) and semantic tokens.
- If a table answers the question faster, use a table.

## Interaction states

| State | Pattern |
|---|---|
| Loading | `Skeleton` matching the final layout |
| Empty | `Empty` with one clear action |
| Error | message + retry + request ID |
| No results | explain active filters + reset action |
| Pending mutation | disable control + `Spinner` |
| Success | toast or inline confirmation, not both |
| Optimistic update | roll back and show an error on failure |

Do not show a spinner in the middle of an otherwise empty page; use a skeleton of the real layout.

## Overlays

- `Dialog`, `Sheet`, and `Drawer` always need a title.
- Destructive actions use `AlertDialog` with the object name and consequence.
- Long forms in overlays need a sticky footer with cancel/save.
- Overlays inherit the global theme and tokens; no separate dark/light island.
- Do not nest a dialog inside a sheet unless the flow truly requires it.

## Accessibility

- Icon-only buttons have `aria-label`.
- Decorative icons are `aria-hidden`; standalone meaningful icons have a title.
- Focus is always visible; use `ring-ring`.
- Dialog/sheet titles are present; screen readers announce them.
- Table headers use `th`; sortable headers are buttons with `aria-sort`.
- Form controls are linked to labels and error text.
- Contrast: 4.5:1 for body text, 3:1 for large text and UI boundaries.
- Respect `prefers-reduced-motion`.
- Keyboard: tab order follows visual order; Escape closes overlays; Enter submits forms.

## Redesign and content preservation

When changing an existing screen:

1. Inventory every field, value, unit, status, tab, column, action, and helper text.
2. Build a one-to-one mapping from old location to new location.
3. Keep module order, grouping, hierarchy, table columns, and navigation semantics unless the user approves a change.
4. Responsive layouts may collapse or move content into menus/drawers, but may not delete it.
5. List any intentional content change in the delivery notes.

## Pre-delivery checklist

- [ ] Shell, page header, and spacing match other pages.
- [ ] One primary action per region.
- [ ] Table has loading, empty, error, and no-result states.
- [ ] Form errors are inline and linked to controls.
- [ ] Status is not color-only.
- [ ] Charts have title, range, unit, legend, and states.
- [ ] No dual axis, 3D chart, or decorative risk color.
- [ ] Dialogs/sheets have titles and sticky footers where needed.
- [ ] Keyboard navigation and focus rings work.
- [ ] Tested at 1440px, 1280px, and 375px widths.
- [ ] No new color, font, icon, or token system was introduced.
- [ ] `vp check` and `vp build` pass.
- [ ] React Doctor: 0 errors; warnings triaged with a reason.
- [ ] React Doctor score (when enabled) and counts are included in the delivery notes.
