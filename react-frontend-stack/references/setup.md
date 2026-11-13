# Setup: React + Vite+ + shadcn + TanStack

Verified on 2026-11-13 with Vite+ 1.6.0, create-vite 9.3.4, React 19.3, TypeScript 7.0, shadcn CLI 4.23.0, Tailwind 4.x, TanStack Router 1.170 / Query 5.107 / Table 9.3 / Form 1.33.

## 0. Install Vite+

Windows:

```powershell
irm https://viteplus.dev/install.ps1 | iex
```

macOS / Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Verify:

```bash
vp --version
vp toolchain
```

Without the global CLI, every `vp` command below can be replaced by `npx create-vite-plus@latest` for creation, and by `npx vp ...` after `vite-plus` is a dev dependency.

## 1. Scaffold the React app

```bash
vp create vite --no-interactive -- my-app --template react-ts
cd my-app
```

This runs `create-vite`, then immediately migrates the result to Vite+:

- adds `vite-plus` and aliases `vite` to `@voidzero-dev/vite-plus-core`
- rewrites `vite.config.ts` imports to `vite-plus`
- wraps plugins in `lazyPlugins(() => [...])`
- moves lint config into the `lint` block of `vite.config.ts`
- adds `staged`, `fmt`, and type-aware check defaults
- installs dependencies

Useful flags:

```bash
# keep the generated project minimal
vp create vite --no-interactive --no-git --no-agent --no-editor --no-hooks -- my-app --template react-ts

# inspect templates
vp create --list
```

By default the Vite+ create flow also writes `AGENTS.md` and `.vite-hooks/pre-commit`; the flags above skip them.

**Do not use `vite:application` for React.** It currently scaffolds a vanilla TypeScript app (no React).

If you already have a plain Vite React app:

```bash
vp add -D vite-plus
vp migrate --no-interactive
```

`vp migrate` expects Vite 7+ and Vitest 4+. Review the rewrite of `vite.config.ts` and `package.json` scripts afterwards.

## 2. Add the runtime dependencies

```bash
vp add tailwindcss @tailwindcss/vite
vp add @tanstack/react-router @tanstack/react-query kubai-icons-react
vp add -D @tanstack/router-plugin @tanstack/react-router-devtools @tanstack/react-query-devtools

# add these only when the feature needs them
vp add @tanstack/react-table @tanstack/react-form @tanstack/react-virtual
```

`vp add -D` maps to `devDependencies`. `vp add` wraps the project's package manager.

Add the standard scripts so every contributor runs the same gates:

```json
{
  "scripts": {
    "check": "vp check",
    "check:fix": "vp check --fix",
    "doctor": "vp dlx react-doctor@latest --no-telemetry"
  }
}
```

`doctor` is mandatory, not optional. It runs React Doctor via `dlx`, so it does not add `react-doctor` or a second TypeScript to the project.

## 3. Wire Vite config

```ts
// vite.config.ts
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, lazyPlugins } from "vite-plus"

export default defineConfig({
  plugins: lazyPlugins(() => [
    // Router plugin must run before the React plugin.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ]),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  lint: {
    plugins: ["react", "typescript", "oxc"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": ["warn", { allowConstantExport: true }],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    ignorePatterns: ["dist/**", "src/routeTree.gen.ts"],
    overrides: [
      {
        // Route files export both `Route` and the page component by design.
        files: ["src/routes/**/*.tsx"],
        rules: { "react/only-export-components": "off" },
      },
    ],
  },
  fmt: {
    ignorePatterns: ["dist/**", "src/routeTree.gen.ts"],
  },
})
```

Notes:

- `lazyPlugins` is the Vite+ idiom for the `plugins` array. Keep the ordered array inside it.
- `@vitejs/plugin-react` is still a separate package; Vite+ bundles Vite, not the framework plugin.
- Do not add `vite`, `vitest`, `oxlint`, or `oxfmt` directly.

## 4. Configure path aliases for shadcn

Add the same `paths` block to both files. **Do not add `baseUrl`** (TypeScript 7 removed it; Vite+ typecheck fails on it).

```jsonc
// tsconfig.json
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }],
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

```jsonc
// tsconfig.app.json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
    // ...existing options
  }
}
```

`paths` without `baseUrl` resolves relative to the tsconfig file. Both the shadcn alias check and `vp check` accept this.

## 5. Tailwind CSS v4

`src/index.css`:

```css
@import "tailwindcss";
```

Tailwind v4 is CSS-first: no `tailwind.config.js`. Theme tokens live in CSS as `@theme` / `:root` variables. shadcn init will expand this file with its token block.

## 6. Initialize shadcn

```bash
vp dlx shadcn@latest init -y -t vite -b radix -p nova
```

- `-p nova` is required in non-interactive runs; without a preset the CLI opens an interactive picker.
- `-b radix` selects Radix primitives (`asChild`). Use `-b base` for Base UI (`render`) or `-b aria` for React Aria, but match the project's existing choice.
- The preset controls style, base color, font, radius, and menu settings. Current presets: `nova`, `vega`, `maia`, `lyra`, `mira`, `luma`, `sera`, `rhea`, `custom`.

After init, `components.json` should look like:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "radix-nova",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

Add components only as needed:

```bash
vp dlx shadcn@latest add button card field input table dialog dropdown-menu sheet tabs
```

Then format the generated source:

```bash
vp check --fix
```

Generated shadcn files often use a different quote/semicolon style than Oxfmt. This is expected; do not exclude `src/components/ui/**` from formatting.

## 7. Router + Query entry point

`src/routes/__root.tsx`:

```tsx
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router"
import type { QueryClient } from "@tanstack/react-query"

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
})

function RootLayout() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b">
        <nav className="mx-auto flex max-w-5xl gap-4 p-4 text-sm">
          <Link to="/" className="[&.active]:font-semibold">
            Home
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl p-6">
        <Outlet />
      </main>
    </div>
  )
}
```

`src/routes/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
  component: Home,
})

function Home() {
  return <h1 className="text-2xl font-semibold">Hello</h1>
}
```

`src/main.tsx`:

```tsx
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRouter, RouterProvider } from "@tanstack/react-router"
import "./index.css"
import { routeTree } from "./routeTree.gen"

const queryClient = new QueryClient()

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  scrollRestoration: true,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
```

`src/routeTree.gen.ts` is generated by the plugin on `vp dev` / `vp build`. Do not edit it.

## 8. Verify

The Router plugin creates `src/routeTree.gen.ts` on the first `vp dev` or `vp build`. On a fresh project, run one of those before `vp check`; otherwise typecheck cannot resolve `./routeTree.gen` and route literals are untyped.

```bash
vp build      # also generates routeTree.gen.ts
vp check
vp test
vp dlx react-doctor@latest --no-telemetry  # mandatory
```

Expected: typecheck, tests, build, and React Doctor all pass. If `vp check` only reports formatting, run `vp check --fix` and re-run. If it reports `routeTree.gen` missing, start `vp dev` once (then stop it) or run `vp build` first.

React Doctor is a separate mandatory gate. Fix every error; triage warnings. Use `--score` for the numeric score and `--json` for automation. For CI, run the changed-files gate:

```bash
vp dlx react-doctor@latest --scope changed --base origin/main --blocking error --no-telemetry
```

See `references/react-doctor.md` for rules, config, scopes, and exit codes.

## Migrating an existing Vite project

Do this on a branch; `vp migrate` rewrites config, imports, and formatting.

```bash
vp add -D vite-plus
vp exec vp migrate --no-interactive
```

What it changes:

- aliases `vite` to `@voidzero-dev/vite-plus-core`
- rewrites `vite` / `vitest` imports to `vite-plus` / `vite-plus/test`
- adds a pnpm `catalog` and `overrides` for `vite` / `vitest`
- upgrades Vitest (Vite+ 1.6 currently brings Vitest 5.x) and moves the browser provider to `vite-plus/test/browser-playwright`
- adds `fmt` / `lint` / `staged` blocks to `vite.config.ts`
- adds `.vitest/` to `.gitignore`

Then:

1. Run `vp check --fix`. Expect a large formatting diff; that is Oxfmt replacing Prettier.
2. Remove ESLint/Prettier only after checking plugin parity. Oxfmt supports `sortImports` and `sortTailwindcss`, which covers the common Prettier plugins.
3. Update Vitest assertions for v5: `toHaveTextContent(RegExp)` → `toMatchTextContent(RegExp)`.
4. Check node-version pins and package-manager pins. pnpm 12 reads build approvals from `pnpm-workspace.yaml`:
   ```yaml
   allowBuilds:
     esbuild: true
   ```
5. Run `vp test`. If Playwright rejects the OS, upgrade Playwright to a version that supports it.

Keep the old lint/format tooling until `vp check` passes; do not delete it in the same commit as the migration.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Option 'baseUrl' has been removed` | Remove `baseUrl`; keep `paths`. TS 7 behavior. |
| shadcn: "No Tailwind CSS configuration found" | Install `tailwindcss` + `@tailwindcss/vite`, add plugin, `@import "tailwindcss";`, then re-run init. |
| shadcn: "Could not find valid path aliases" | Add `paths` to `tsconfig.json` **and** `tsconfig.app.json`; no `baseUrl`. |
| shadcn init hangs on a preset prompt | Pass `-p nova` (or another preset). |
| `vue`/vanilla files after `vite:application` | That template is not React. Use `vite --template react-ts`. |
| `routeTree.gen.ts` errors in the editor after a rename | Mark it read-only and exclude it from search/watch. |
| `vp check` fails on shadcn files | Run `vp check --fix`; generated style differs from Oxfmt defaults. |
| `Cannot find module './routeTree.gen'` | Run `vp build` or `vp dev` once; the Router plugin generates it. |
| `EBADDEVENGINES` from npm | The scaffold pins `devEngines.packageManager`; use global `vp` or align the pin with `vp env`. |
| Duplicate `@voidzero-dev/vite-plus-core` / SSR `instanceof` failure | `vp dedupe`, then confirm one copy under `node_modules`. |
| `vp dev` vs `vp run dev` differ | `vp dev` is the built-in; `vp run dev` runs the `package.json` script. |
| React Doctor reports errors | Fix them before delivery; do not disable rules to raise the score. |
| React Doctor Socket.dev check hangs | Use `--no-supply-chain` for offline/blocked networks; keep telemetry off with `--no-telemetry`. |
| React Doctor wants a different TypeScript | Its package requires TS `<6`; run it with `vp dlx` / `npx` instead of adding it to the project. |
| React Doctor exit code 1 with `--blocking error` | Expected when errors exist; inspect, fix, re-run. Use `--blocking none` only for advisory scans. |

## VS Code settings for the generated route tree

```json
{
  "files.readonlyInclude": { "**/routeTree.gen.ts": true },
  "files.watcherExclude": { "**/routeTree.gen.ts": true },
  "search.exclude": { "**/routeTree.gen.ts": true }
}
```
