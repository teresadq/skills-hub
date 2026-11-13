# shadcn/ui, Tailwind, and Kubai Icons

## shadcn/ui

### Workflow

```bash
# inspect what is installed and which primitive base is active
vp dlx shadcn@latest info --json

# find a component before writing one
vp dlx shadcn@latest search <term>

# add source into src/components/ui/
vp dlx shadcn@latest add <component>

# preview an update before overwriting local edits
vp dlx shadcn@latest add <component> --dry-run
```

- Components are **source**, not a dependency. Edit them when the project needs it.
- `components.json` is the contract: `style`, `base` (radix / base / aria), `iconLibrary`, aliases.
- Do not switch `base` mid-project. Radix uses `asChild`; Base UI uses `render`; React Aria has its own composition.
- Use `npx`/`pnpm dlx`/`vp dlx` according to the project. In this stack, `vp dlx` is the default.

### Composition rules

**Use an existing component before custom markup.**

| Need | Use |
|---|---|
| Callout / notice | `Alert` |
| Empty state | `Empty` |
| Loading placeholder | `Skeleton` |
| Divider | `Separator` |
| Toast (Radix/Aria) | `sonner` |
| Toast (Base UI) | `toast` component |
| Settings page | `Tabs` + `Card` + form controls |
| Dashboard | `Sidebar` + `Card` + `Chart` + `Table` |

**Structure**

- `Dialog`, `Sheet`, and `Drawer` always need a title (`DialogTitle`, `SheetTitle`, `DrawerTitle`); use `sr-only` if visually hidden.
- `SelectItem` inside `SelectGroup`; `DropdownMenuItem` inside `DropdownMenuGroup`; `CommandItem` inside `CommandGroup`.
- `TabsTrigger` inside `TabsList`.
- `Avatar` always has `AvatarFallback`.
- Use the full `Card` composition: `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` / `CardFooter`.
- Button has no `isLoading`/`isPending`. Compose `Spinner` + `data-icon` + `disabled`.
- Use `asChild` (Radix) or `render` (Base) for custom triggers. Check `base` in `shadcn info`.

### Forms

- Layout: `FieldGroup` → `Field` → `FieldLabel` + control + `FieldDescription` + `FieldError`.
- Do not use raw `div` with `space-y-*` or `grid gap-*` as form layout.
- Validation: `data-invalid` on `Field`, `aria-invalid` on the control.
- Disabled: `data-disabled` on `Field`, `disabled` on the control.
- `InputGroup` uses `InputGroupInput` / `InputGroupTextarea`; never raw `Input` / `Textarea` inside it.
- Buttons inside inputs use `InputGroup` + `InputGroupAddon`.
- 2–7 mutually exclusive choices use `ToggleGroup`, not a loop of `Button`s.
- Related checkboxes/radios use `FieldSet` + `FieldLegend`.

### Tailwind rules

- `className` is for layout and spacing. Do not override component colors or typography.
- Semantic tokens only: `bg-background`, `bg-card`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-primary-foreground`, `ring-ring`, `destructive`.
- No `bg-blue-500`, `text-gray-600`, or `dark:text-white` in app code. The token system already handles light/dark.
- No `space-x-*` / `space-y-*`. Use `flex flex-col gap-*` or `flex gap-*`.
- Square elements use `size-*` (`size-10`, not `w-10 h-10`).
- Truncation uses `truncate`.
- Conditional classes use `cn()`; no manual template-literal ternaries.
- Do not set `z-index` on Dialog/Sheet/Popover/Dropdown; the primitive owns its stacking.
- Arbitrary values are a last resort. If the design needs a new value repeatedly, add a token.

Tailwind v4 is CSS-first:

```css
@import "tailwindcss";

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  /* shadcn init fills the rest */
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
}
```

No `tailwind.config.js`. shadcn's generated `@theme inline` block maps CSS variables to utilities.

## Kubai Icons

`kubai-icons-react` ships one tree-shakable React component per icon, with a hover motion per icon and `currentColor` by default.

```bash
vp add kubai-icons-react
```

### Imports

Prefer per-icon subpaths in app code:

```tsx
import Folder from "kubai-icons-react/icons/folder"
import Settings from "kubai-icons-react/icons/settings"
import CirclePlus from "kubai-icons-react/icons/circle-plus"
```

The named barrel also works:

```tsx
import { Folder, Settings, CirclePlus } from "kubai-icons-react"
```

Measured in a 3-icon page: the barrel transformed ~7,155 modules; subpath imports transformed 281 with the same final bundle size. Subpaths also keep editor type-checking fast. Use the barrel only for quick prototyping.

Create one app-level entry point so icon imports are easy to audit:

```ts
// src/components/icons.ts
export { default as FolderIcon } from "kubai-icons-react/icons/folder"
export { default as SettingsIcon } from "kubai-icons-react/icons/settings"
export { default as CirclePlusIcon } from "kubai-icons-react/icons/circle-plus"
export { default as BookmarkIcon } from "kubai-icons-react/icons/bookmark"
```

```tsx
import { FolderIcon, CirclePlusIcon } from "@/components/icons"
```

### Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `size` | `number \| string` | `24` | width and height |
| `color` | `string` | `currentColor` | accent color; gradients/outlines derive from it |
| `variant` | `"color" \| "soft"` | `"color"` | `soft` lifts fills and deepens outlines |
| `badgeColor` | `string \| "semantic"` | black/white | corner badge ink; `"semantic"` gives add/remove colors |
| `trigger` | `"hover" \| "parent" \| "none"` | `"hover"` | what plays the motion |
| `hover` | `boolean` | — | controlled motion; true plays, false reverses |
| `active` / `defaultActive` / `onActiveChange` | toggle state | — | for bookmark/like-style icons |
| `title` | `string` | — | accessible name; without it the icon is `aria-hidden` |
| other | `SVGProps<SVGSVGElement>` | — | passthrough |

### Usage patterns

```tsx
import { Button } from "@/components/ui/button"
import { BookmarkIcon, CirclePlusIcon, SettingsIcon } from "@/components/icons"

// Icon + label inside a button
<Button>
  <CirclePlusIcon data-icon="inline-start" />
  New project
</Button>

// Icon-only button: the button owns the accessible name
<Button variant="outline" size="icon" aria-label="Settings">
  <SettingsIcon />
</Button>

// Parent-triggered motion
<button data-kubai-trigger className="flex items-center gap-2">
  <FolderIcon size={18} trigger="parent" />
  Open folder
</button>

// Controlled toggle
<BookmarkIcon
  active={saved}
  onActiveChange={setSaved}
  title={saved ? "Remove bookmark" : "Add bookmark"}
/>
```

### Rules

- **Kubai is the product icon set.** Use it for navigation, actions, empty states, feature cards, status, and identity.
- **Lucide stays inside shadcn primitives.** shadcn components import `lucide-react` for chevrons, checks, close buttons, and internal affordances. Do not bulk-replace those imports; Kubai naming is not a drop-in Lucide alias.
- Do not set `color` unless the icon must differ from surrounding text. `currentColor` is the default and keeps dark mode correct.
- Decorative icons: omit `title` (the library renders `aria-hidden`). Meaningful standalone icons: pass `title`. Icon-only buttons: `aria-label` on the button.
- Hover motion is decoration, never the only signal for state. Pair toggles with `aria-pressed` or text.
- The library respects `prefers-reduced-motion`; do not add your own infinite animation on top.
- `DynamicIcon` from `kubai-icons-react/dynamic` is for runtime icon names. It defeats static tree-shaking; use it only for data-driven icon pickers, with a `fallback`.

### Name mapping

Kubai uses descriptive names that are close to, but not identical to, Lucide:

| Concept | Kubai |
|---|---|
| Add | `CirclePlus` |
| Remove | `CircleMinus` |
| Close | `CircleX` |
| Confirm | `CircleCheck` |
| Warning | `TriangleAlert` / `CircleAlert` |
| Help | `CircleHelp` |
| Search | `Search` |
| Settings | `Settings` |
| Home | `Home` |
| Dashboard | `LayoutDashboard` |
| Analytics | `ChartBar` / `ChartLine` |
| Users | `Users` / `UserRound` |
| Mail | `Mail` |
| Calendar | `Calendar` |
| Folder | `Folder` / `FolderOpen` |
| File | `File` / `FileText` |
| Image | `Image` |
| Link | `Link` |
| Copy | `Copy` |
| Edit | `Pencil` |
| Delete | `Trash` |
| Filter | `Filter` |
| Menu | `Menu` |
| More | `MoreHorizontal` / `MoreVertical` |
| Chevron | `ChevronDown` / `ChevronRight` / `ChevronLeft` |
| Lock | `Lock` |
| Eye | `Eye` / `EyeOff` |
| Download | `Download` |
| Share | `Share` |
| Log out | `LogOut` |
| Database | `Database` |
| Server | `Server` |
| Cloud | `Cloud` |

Pick by meaning and visual fit, not by matching a Lucide name one-to-one.

### License

- Icons and npm packages: MIT.
- The Kubai website, tools, tests, and docs: all rights reserved.
- The bundled Kubai agent skill uses a custom license; do not copy its `SKILL.md`/`PROMPT.md` into this project. Depend on the npm package or the public documentation instead.

## Accessibility checklist

- Icon-only controls have `aria-label`.
- Decorative icons do not announce.
- Dialogs/sheets/drawers have titles.
- Form errors are linked through `aria-invalid` and visible `FieldError` text.
- Focus rings use `ring-ring`; do not remove focus outlines without a replacement.
- Color is never the only status signal; pair with text or an icon shape.
- Test keyboard navigation for menus, dialogs, tabs, and tables.
