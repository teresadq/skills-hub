# TanStack Stack

Use the smallest tool that owns the state:

| State | Owner |
|---|---|
| Remote/server data, caching, retries, mutations | TanStack Query |
| URL path, search params, navigation | TanStack Router |
| Form values and validation | TanStack Form |
| Table sorting/filtering/pagination/selection | TanStack Table |
| Long lists | TanStack Virtual |
| Shared writable client state | TanStack Store |
| SSR, server functions, API routes | TanStack Start (optional) |
| Local-first collections / sync | TanStack DB (RC, optional) |

Do not duplicate the same state in two owners. A filter that lives in the URL should not also live in `useState`; server data should not be copied into a store.

## Router (file-based)

Plugin order in `vite.config.ts`:

```ts
tanstackRouter({ target: "react", autoCodeSplitting: true }),
react(),
```

Defaults: routes in `src/routes`, generated tree at `src/routeTree.gen.ts`, ignored files prefixed `-`.

### File conventions

| File | URL |
|---|---|
| `routes/__root.tsx` | layout for everything |
| `routes/index.tsx` | `/` |
| `routes/people.tsx` | `/people` |
| `routes/people.$personId.tsx` | `/people/:personId` |
| `routes/people.index.tsx` | `/people` index |
| `routes/_auth.tsx` | pathless layout |
| `routes/_auth/settings.tsx` | `/settings` under `_auth` layout |
| `routes/people.$personId.edit.tsx` | `/people/:personId/edit` |

### Typed search params

```tsx
import { createFileRoute } from "@tanstack/react-router"

type PeopleSearch = {
  page: number
  q: string
}

export const Route = createFileRoute("/people/")({
  validateSearch: (search: Record<string, unknown>): PeopleSearch => ({
    page: Math.max(1, Number(search.page) || 1),
    q: typeof search.q === "string" ? search.q : "",
  }),
  component: PeoplePage,
})

function PeoplePage() {
  const { page, q } = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <input
      value={q}
      onChange={(e) =>
        navigate({ search: (prev) => ({ ...prev, q: e.target.value, page: 1 }) })
      }
    />
  )
}
```

`validateSearch` can also use a Zod schema through `@tanstack/zod-adapter`, but a plain function needs no extra dependency.

### Loaders + Query

```tsx
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"

const peopleQuery = (page: number) =>
  queryOptions({
    queryKey: ["people", { page }],
    queryFn: () => fetch(`/api/people?page=${page}`).then((r) => r.json()),
    staleTime: 30_000,
  })

export const Route = createFileRoute("/people/")({
  validateSearch: (search: Record<string, unknown>) => ({
    page: Math.max(1, Number(search.page) || 1),
  }),
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: ({ context: { queryClient }, deps }) =>
    queryClient.ensureQueryData(peopleQuery(deps.page)),
  pendingComponent: () => <div className="text-muted-foreground">Loading…</div>,
  errorComponent: ({ error }) => <div role="alert">{error.message}</div>,
  component: PeoplePage,
})

function PeoplePage() {
  const { page } = Route.useSearch()
  const { data } = useSuspenseQuery(peopleQuery(page))
  return <pre>{JSON.stringify(data, null, 2)}</pre>
}
```

Add `defaultPreloadStaleTime: 0` to `createRouter` when loaders use Query, otherwise the router's preload cache can serve stale loader results before Query revalidates.

### Root context

```tsx
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
})
```

`loader({ context })` is then typed with `queryClient`. Register the router type in `main.tsx` so `Link` and `navigate` are typed everywhere:

```ts
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
```

### Rules

- Keep route files thin: validate search, load data, compose a feature component.
- Use `Link` and `navigate` from Router, never raw `<a href>` for internal navigation.
- Put auth/layout shells in pathless routes (`_auth.tsx`), not in every page.
- Do not edit `routeTree.gen.ts`.

## Query

### Query options live with the feature

```ts
// features/people/api.ts
import { queryOptions } from "@tanstack/react-query"

export const peopleKeys = {
  all: ["people"] as const,
  list: (page: number) => [...peopleKeys.all, "list", { page }] as const,
  detail: (id: string) => [...peopleKeys.all, "detail", id] as const,
}

export const peopleListQuery = (page: number) =>
  queryOptions({
    queryKey: peopleKeys.list(page),
    queryFn: () => api.getPeople(page),
    staleTime: 30_000,
  })
```

### Mutations

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query"

export function useCreatePerson() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: NewPerson) => api.createPerson(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: peopleKeys.all })
    },
  })
}
```

- `useQuery` for non-blocking reads; `useSuspenseQuery` inside routes with `pendingComponent`.
- `ensureQueryData` in loaders; `prefetchQuery` for hover/intent prefetch.
- Query keys are arrays and hierarchical. Invalidate by prefix.
- Do not put derived client state in Query. Use `select` for cheap projections.
- Disable refetch-on-focus for dashboards that should stay still: set it on `QueryClient` defaults, not per hook.

## Table v9

Table v9 is tree-shakable: features, row models, and Fn registries are opt-in.

```tsx
import { useState } from "react"
import {
  columnFilteringFeature,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  flexRender,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table"

type Person = { name: string; email: string }

// Define once at module scope; a new object each render invalidates memos.
const features = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
  filterFns: { includesString: filterFn_includesString },
})

const columns: ColumnDef<typeof features, Person>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "email", header: "Email" },
]

export function PeopleTable({ data }: { data: Person[] }) {
  const [sorting, setSorting] = useState<SortingState>([])

  const table = useTable({
    features,
    columns,
    data,
    state: { sorting },
    onSortingChange: setSorting,
  })

  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th key={header.id}>
                {flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getAllCells().map((cell) => (
              <td key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

### v9 rules and gotchas

- `useReactTable` → `useTable`.
- `features` is required. Use `stockFeatures` for v8-like all-in behavior, at bundle cost.
- `ColumnDef<TFeatures, TData>`; the feature type is the first generic.
- `getVisibleCells()` belongs to `columnVisibilityFeature`. If you did not register it, use `getAllCells()`.
- Read state through `table.state`, not `table.getState()`.
- Call instance methods on the instance: `row.getValue("name")`, not `const { getValue } = row`.
- Sorting names changed: `sortingFn` → `sortFn`, `sortingFns` → `sortFns`, `getSortingFn()` → `getSortFn()`.
- Pinning uses logical `start`/`end`, not `left`/`right`.
- Use individual `sortFn_*` / `filterFn_*` functions instead of spreading the full registry.
- For server-side data, set `manualPagination`, `manualSorting`, `manualFiltering` and pass `pageCount`.

### shadcn table

Add the primitive:

```bash
vp dlx shadcn@latest add table
```

Keep the shadcn `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` wrappers as the markup layer. Table v9 stays headless; do not rebuild a second table component around it.

## Form

TanStack Form is headless. Pair it with shadcn `Field` primitives.

```bash
vp dlx shadcn@latest add field input
```

```tsx
import { useForm } from "@tanstack/react-form"
import * as z from "zod"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

const schema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters."),
  email: z.email("Enter a valid email."),
})

export function SettingsForm() {
  const form = useForm({
    defaultValues: { name: "", email: "" },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      await saveSettings(value)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <FieldGroup>
        <form.Field
          name="name"
          children={(field) => {
            const invalid = field.state.meta.isTouched && !field.state.meta.isValid
            return (
              <Field data-invalid={invalid}>
                <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  aria-invalid={invalid}
                  autoComplete="name"
                />
                <FieldDescription>Your display name.</FieldDescription>
                {invalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            )
          }}
        />
      </FieldGroup>
      <Button type="submit">Save</Button>
    </form>
  )
}
```

Rules:

- Use `FieldGroup` + `Field`; never raw `div` + `space-y-*`.
- `data-invalid` on `Field`, `aria-invalid` on the control.
- `FieldError errors={field.state.meta.errors}` works directly with Standard Schema (Zod) issues.
- `form.handleSubmit()` returns a promise. Use `void` or `await`; type-aware Oxlint flags floating promises.
- Arrays use `<form.Field name="items" mode="array">` and `field.pushValue` / `field.removeValue`.
- Server errors: return them from `onSubmit` or set `field.state.meta.errors`; do not toast-only.

## Virtual

```tsx
import { useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"

export function VirtualList({ rows }: { rows: string[] }) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 8,
  })

  return (
    <div ref={parentRef} className="h-80 overflow-auto">
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            className="absolute inset-x-0 top-0 flex items-center px-3"
            style={{
              height: item.size,
              transform: `translateY(${item.start}px)`,
            }}
          >
            {rows[item.index]}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- Use dynamic measurement (`measureElement`) when row heights vary.
- Virtualize the list, not the page. The scroll container needs a bounded height.
- For tables, pair Table v9 with Virtual only after confirming the row count justifies it.

## Store

Use TanStack Store only for shared writable client state (theme draft, editor selection, cross-feature UI state).

```ts
import { Store } from "@tanstack/store"
import { useStore } from "@tanstack/react-store"

export const sidebarStore = new Store({ open: true })

export function useSidebarOpen() {
  return useStore(sidebarStore, (state) => state.open)
}

sidebarStore.setState((state) => ({ ...state, open: !state.open }))
```

If the state is server data, URL state, or form state, it does not belong here.

## Start (optional)

Choose TanStack Start only when the app needs SSR, streaming, server functions, or API routes. A Vite SPA with Router + Query is simpler and is the default for internal tools and dashboards.

```bash
vp create @tanstack/start --no-interactive -- my-app
# if the template is not already on Vite+:
vp migrate --no-interactive
```

- Start is built on Vite + Router, so Vite+ is a supported combination.
- Known issue: duplicate `@voidzero-dev/vite-plus-core` can break SSR `instanceof` checks. Run `vp dedupe` and verify one copy.
- Server functions use `createServerFn` from `@tanstack/react-start`.
- shadcn can scaffold a Start project with `shadcn init -t start`.

## DB (optional, RC)

`@tanstack/react-db` is still a release candidate. Do not make it the default for CRUD screens. Use Query + REST/RPC first. Consider DB only for local-first collections, optimistic sync, or complex client-side joins where its collection model clearly pays for itself.

## Testing

Vite+ bundles Vitest. Import from Vite+:

```ts
import { describe, expect, it } from "vite-plus/test"
```

Config goes in the `test` block of `vite.config.ts`:

```ts
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
})
```

Add `@testing-library/react`, `@testing-library/user-event`, and `jsdom` separately; Vite+ does not bundle Testing Library. For route components, render with a fresh `QueryClientProvider` and `RouterProvider` (or test the feature component directly with a mocked `queryClient`).

Run:

```bash
vp test
```
