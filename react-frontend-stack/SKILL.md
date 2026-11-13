---
name: react-frontend-stack
description: Build and maintain React frontends with Vite+ (vp), shadcn/ui, Tailwind CSS v4, and the TanStack stack (Router, Query, Table v9, Form, Virtual, Store, optional Start/DB). Uses Kubai Icons (kubai-icons-react) as the product icon set and React Doctor as a mandatory issue scan. Use when scaffolding a React app, building admin/dashboard screens, adding routes/data tables/forms, wiring shadcn components or themes, choosing state management, configuring Vite+/vp commands, auditing React code, or when the user mentions React + Vite、shadcn/ui、Tailwind、TanStack、Vite+、React Doctor、后台管理系统 or Kubai icons.
---

# React Frontend Stack

Default stack for new frontend work:

| Concern | Choice |
|---|---|
| Runtime / dev / build | **Vite+** (`vite-plus`, `vp`) |
| UI framework | **React 19 + TypeScript** |
| Components | **shadcn/ui** (source in repo) |
| Styling | **Tailwind CSS v4** (CSS-first, no `tailwind.config.js`) |
| Routing / URL state | **TanStack Router** (file-based) |
| Server state | **TanStack Query** |
| Tables | **TanStack Table v9** |
| Forms | **TanStack Form** + shadcn `Field` |
| Virtualization | **TanStack Virtual** |
| Global client state | **TanStack Store** (only when needed) |
| SSR / server functions | **TanStack Start** (optional) |
| Icons | **Kubai Icons** (`kubai-icons-react`) |

Do not install Vite, Vitest, Oxlint, or Oxfmt separately. Vite+ owns them.

## Read the right reference

- Fresh project, Vite+ setup, shadcn/Tailwind wiring, known breakages → `references/setup.md`
- Router, Query, Table v9, Form, Virtual, Store, Start, DB → `references/tanstack.md`
- shadcn composition rules, Tailwind tokens, Kubai icon API → `references/ui-and-icons.md`
- Admin page skeletons, density, tables, forms, charts, states, QA → `references/admin-ui.md`
- React Doctor scan, rules, CI gate, score interpretation → `references/react-doctor.md`
- Validate an existing repo → `node scripts/check-stack.mjs`

Read only the reference the task needs.

## Non-negotiables

1. **Vite+ is the toolchain.** Import `defineConfig` from `vite-plus`, run `vp dev`, `vp check`, `vp test`, `vp build`. Never add `vite`, `vitest`, `oxlint`, `oxfmt`, or `eslint` as direct dependencies.
2. **shadcn components are source.** Add with the CLI; edit them locally when needed. Do not wrap a shadcn component in a second "design system" wrapper just to rename props.
3. **Semantic Tailwind tokens only.** `bg-background`, `text-muted-foreground`, `border-border`, `bg-primary`. No `bg-blue-500` or manual `dark:` color overrides.
4. **Kubai for product icons, Lucide for shadcn internals.** shadcn components import `lucide-react` internally; leave those imports alone unless you are deliberately restyling that primitive. App navigation, empty states, actions, and feature icons come from Kubai.
5. **Server state belongs to TanStack Query.** No `useEffect` + `fetch`, no global store for API data, no hand-rolled caching.
6. **URL state belongs to TanStack Router.** Filters, tabs, pagination, and search go in `validateSearch`, not `useState`, when they should survive reload/share.
7. **Forms use TanStack Form + shadcn `FieldGroup`/`Field`.** Do not build form layout from raw `div`s with `space-y-*`.
8. **Table v9 features are opt-in.** Pass `features: tableFeatures({...})`; call methods on the instance (`row.getValue()`, not destructured).
9. **No `baseUrl` in tsconfig.** Vite+ uses TypeScript 7, which removed it. Use `paths` with relative targets.
10. **Verify with `vp check`, `vp build`, and React Doctor.** Formatting, lint, type checks, and build must pass. React Doctor is mandatory: run `vp dlx react-doctor@latest --no-telemetry` and fix all errors before claiming done.
11. **Do not silence React Doctor to raise a score.** Fix the issue, or document a justified suppression in `doctor.config.ts`; never disable a rule just to get green.

## Workflow

### 1. Detect before scaffolding

If `package.json` exists, do not scaffold. Read it and `vite.config.*`, then:

```bash
node scripts/check-stack.mjs
```

Add only what is missing. If the project uses Next.js, React Router, or plain Vite without Vite+, ask before migrating; migration is user-visible.

### 2. New React app

```bash
# No global vp yet (Windows)
irm https://viteplus.dev/install.ps1 | iex
# macOS / Linux
# curl -fsSL https://vite.plus | bash

vp create vite --no-interactive -- my-app --template react-ts
cd my-app
```

The `vite` shorthand runs `create-vite` **and** migrates the result to Vite+: `vite-plus` dependency, rewritten config import, `lazyPlugins`, lint/format blocks, and installed dependencies. Without the global CLI, use `npx create-vite-plus@latest vite --no-interactive -- my-app --template react-ts`.

`vite:application` is a **vanilla TS** template today. For React, use the `vite` shorthand above. Full commands and troubleshooting are in `references/setup.md`.

### 3. Add Tailwind, shadcn, and the TanStack stack

```bash
vp add tailwindcss @tailwindcss/vite
vp add @tanstack/react-router @tanstack/react-query
vp add -D @tanstack/router-plugin @tanstack/react-router-devtools @tanstack/react-query-devtools
vp add kubai-icons-react
```

Wire Tailwind, the router plugin, and the `@` alias in `vite.config.ts`, then initialize shadcn:

```bash
vp dlx shadcn@latest init -y -t vite -b radix -p nova
vp dlx shadcn@latest add button card field input table dialog dropdown-menu
```

`-p nova` is required for non-interactive init; without a preset the CLI blocks on a prompt. Use `-b base` or `-b aria` only if the project already chose that primitive.

### 4. Build vertically

For a screen or feature:

1. Route file in `src/routes/` (thin: loader + layout + composition).
2. `features/<domain>/api.ts` with `queryOptions` and mutations.
3. `features/<domain>/components/` with shadcn primitives.
4. `features/<domain>/schema.ts` for Zod search/form schemas.
5. Kubai icons at the interaction points, not on every label.

### 5. Verify

```bash
vp build      # first run also generates src/routeTree.gen.ts
vp check --fix # format + lint + typecheck
vp test        # if tests exist
vp dlx react-doctor@latest --no-telemetry  # MANDATORY issue scan
```

On a fresh project, do not run `vp check` before the route tree exists; typecheck will fail on `./routeTree.gen`. Run `vp build` or `vp dev` once first.

After adding shadcn components, `vp check --fix` is expected: generated files may not match Oxfmt defaults. Do not exclude `src/components/ui/**` from formatting; exclude only `src/routeTree.gen.ts`.

React Doctor is not a replacement for `vp check`: run both. Fix every **error** it reports. Triage **warnings** explicitly; if a warning is a false positive, suppress the specific rule with a comment and reason, never the whole category.

```bash
# score only (enables the score API; do not combine with --no-telemetry)
vp dlx react-doctor@latest --score

# changed-files gate for CI / PR
vp dlx react-doctor@latest --scope changed --base origin/main --blocking error --no-telemetry
```

## Command cheat sheet

| Need | Command |
|---|---|
| Dev server | `vp dev` |
| Static checks + typecheck | `vp check` |
| Autofix format/lint | `vp check --fix` |
| Tests | `vp test` |
| Production build | `vp build` |
| Add dependency | `vp add <pkg>` / `vp add -D <pkg>` |
| Run a package binary | `vp dlx <tool>@latest` |
| React issue scan (required) | `vp dlx react-doctor@latest --no-telemetry` |
| React Doctor score only | `vp dlx react-doctor@latest --score` |
| React Doctor changed-files gate | `vp dlx react-doctor@latest --scope changed --base origin/main --blocking error` |
| Run a TS script | `vpx ./scripts/foo.ts` |
| Run a `package.json` script | `vp run <script>` |
| Show tool versions | `vp toolchain` |
| Diagnose environment | `vp env doctor` |

`vp <name>` is a built-in command; `vp run <name>` is a project script. They can differ. Check `package.json` before assuming.

## Architecture defaults

```text
src/
  routes/                 # TanStack Router file-based routes; routeTree.gen.ts is generated
  features/<domain>/
    api.ts                # queryOptions, mutations, query key factory
    components/
    schema.ts             # Zod schemas for search params and forms
  components/ui/          # shadcn-generated primitives (vendored source)
  lib/utils.ts            # cn()
  main.tsx                # providers: QueryClient -> Router
```

- One `QueryClient` per app; create it in `main.tsx` (or router context).
- Router context carries `queryClient`; route loaders use `ensureQueryData`.
- Keep route components thin. Data shaping and mutations live in the feature module.
- Do not add a global client store until two unrelated features need the same writable state. TanStack Store, not Redux/Zustand, is the default.

## Known gotchas (verified 2026-11)

- **Vite+ + TS 7:** `baseUrl` is rejected. `paths` alone works; shadcn alias detection also works without it.
- **shadcn init order:** Tailwind must be installed and `@/*` paths configured before `shadcn init`, or preflight fails.
- **Vite+ built-in React gap:** `vite:application` is vanilla TS. Use `vite --template react-ts` + `vp migrate`.
- **Table v9 gating:** `row.getVisibleCells()` requires `columnVisibilityFeature`; otherwise use `row.getAllCells()`. `ColumnDef` takes `TFeatures` as its first generic.
- **Route tree timing:** `src/routeTree.gen.ts` is generated by `vp dev` / `vp build`. Running `vp check` first makes typecheck fail on `./routeTree.gen` and untyped route literals.
- **Package-manager pin:** a Vite+ scaffold can pin `devEngines.packageManager`. Running `npx vp` with a different npm version fails with `EBADDEVENGINES`; use the global `vp`, or align the pin with `vp env`.
- **Kubai barrel imports:** named imports from `kubai-icons-react` transformed ~7,155 modules in a 3-icon build; subpath imports (`kubai-icons-react/icons/folder`) transformed 281 with the same bundle size. Prefer subpaths in app code.
- **Kubai naming:** uses `CirclePlus`/`CircleX`/`CircleCheck`, not `Plus`/`X`/`Check`. Do not bulk-replace Lucide imports in shadcn files.
- **TanStack Start + Vite+:** supported, but duplicate `@voidzero-dev/vite-plus-core` copies can break SSR; run `vp dedupe` if `instanceof` checks fail.
- **React Doctor via dlx:** its package depends on TypeScript `<6`. Run it with `vp dlx` / `npx` instead of adding it to a TS 6 project; otherwise a second TypeScript install can appear. Telemetry is on by default; pass `--no-telemetry`.
- **React Doctor score flags:** `--score` cannot be combined with `--no-telemetry`; `--no-telemetry` implies `--no-score`. Report error/warning counts when scoring is disabled.
- **React Doctor exit codes:** `--blocking error` fails on errors, `warning` fails on warnings too, `none` is advisory and always exits 0. Use `--warning-exit-code <2-255>` only when CI needs a distinct warning status.

## Definition of done

A change is complete only when all of these are true:

- [ ] `vp check` passes (format, lint, typecheck)
- [ ] `vp build` passes
- [ ] `vp test` passes when tests exist
- [ ] `vp dlx react-doctor@latest --no-telemetry` reports **0 errors**
- [ ] every warning is fixed or explicitly triaged with a reason
- [ ] delivery notes include the error/warning counts (and score when scoring was enabled)

If React Doctor was not run, the task is not done.

## Sources

- Vite+ docs (bundled locally at `node_modules/vite-plus/docs`): https://viteplus.dev/guide/
- shadcn/ui CLI and docs: https://ui.shadcn.com/docs/cli
- TanStack Router: https://tanstack.com/router/latest/docs/framework/react/quick-start
- TanStack Query: https://tanstack.com/query/latest/docs/framework/react/overview
- TanStack Table v9 migration: https://tanstack.com/table/latest/docs/framework/react/guide/migrating
- TanStack Form: https://tanstack.com/form/latest/docs/framework/react/quick-start
- Kubai Icons: https://icons.kubai.design/docs/react/
- React Doctor: https://react.doctor/docs / https://github.com/millionco/react-doctor
