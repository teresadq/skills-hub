# React Doctor

React Doctor (`react-doctor`) runs deterministic diagnostics on a React codebase and reports issues by category: Security, Bugs, Performance, Accessibility, and Maintainability. It supports Vite, Next.js, Astro, TanStack, React Native, and Expo.

**Mandatory in this skill.** A task is not complete until React Doctor has been run and every error is fixed. Do not silence a rule to make the score green.

## Run it

```bash
# full project scan (required before delivery)
vp dlx react-doctor@latest --no-telemetry

# score only (enables the score API; do not combine with --no-telemetry)
vp dlx react-doctor@latest --score

# machine-readable report
vp dlx react-doctor@latest --json --no-telemetry

# changed-files gate for CI / PR
vp dlx react-doctor@latest --scope changed --base origin/main --blocking error --no-telemetry

# staged files (pre-commit)
vp dlx react-doctor@latest --staged --no-telemetry
```

Why `vp dlx` / `npx` instead of a project dependency: `react-doctor` declares `typescript >=5 <6`. Installing it into a TS 6 project can pull a second TypeScript copy. `dlx` keeps its toolchain isolated. Vite+ projects can use `vp dlx`; non-Vite+ projects use `npx react-doctor@latest`.

## What to report

After a scan, include:

- score (0–100) when scoring is enabled (`--score` or the default); otherwise state that scoring was disabled by `--no-telemetry` / `--no-score`
- error count
- warning count
- affected files
- each fix made, or why a warning is a false positive

Do not say “done” without this output.

## Exit codes

| Flag | Behavior |
|---|---|
| `--blocking error` | exit 1 on any error (CLI default) |
| `--blocking warning` | exit 1 on warnings or errors |
| `--blocking none` | advisory; always exit 0 |
| `--warning-exit-code <2-255>` | distinct exit code for non-blocking warnings |

The GitHub Action defaults to `blocking: none`; do not copy that default into local verification.

## Scopes

| Scope | Reports |
|---|---|
| `full` | every finding (default) |
| `files` | every finding in changed files |
| `changed` | only findings introduced vs the base ref |
| `lines` | findings touching changed lines |
| `contextual` | findings in modified functions / JSX / files |

Use `--base <ref>` when the base cannot be inferred. For gradual cleanup:

```bash
vp dlx react-doctor@latest --scope contextual --base origin/main --blocking none
```

## Rules

```bash
vp dlx react-doctor@latest rules list
vp dlx react-doctor@latest rules explain react-doctor/no-array-index-as-key
vp dlx react-doctor@latest rules set react-doctor/no-danger warn
vp dlx react-doctor@latest rules disable react-doctor/no-danger
vp dlx react-doctor@latest rules category Performance off
```

- `--category <name>` filters the report; repeat the flag for multiple categories.
- `--verbose` shows every rule and per-file details.
- `why <file:line>` explains what React Doctor sees at a location.
- Inline disables are respected by default. Use `--no-respect-inline-disables` to audit whether existing suppressions still hide real issues.

## Config

Create `doctor.config.ts`:

```ts
import { defineConfig } from 'react-doctor/api'

export default defineConfig({
  scope: 'changed',
  blocking: 'error',
  rules: {
    'react-doctor/no-array-index-as-key': 'error',
    'react-doctor/no-danger': 'off',
  },
  categories: {
    Maintainability: 'warn',
  },
  ignore: {
    rules: ['react-doctor/no-danger'],
    files: ['src/generated/**'],
    overrides: [
      {
        files: ['src/components/rich-text.tsx'],
        rules: ['react-doctor/no-danger'],
      },
    ],
  },
})
```

`doctor.config.ts`, `doctor.config.json`, and `package.json` under `reactDoctor` are supported. JSON config uses JSON5. CLI flags override config.

Useful keys:

| Key | Purpose |
|---|---|
| `scope`, `base`, `blocking` | scan scope and CI gate |
| `rules`, `categories` | severity (`error`, `warn`, `off`) |
| `ignore.rules`, `ignore.files`, `ignore.overrides` | drop findings without disabling the rule |
| `customRulesOnly` | run only explicitly configured rules |
| `supplyChain` | Socket.dev dependency scores; `enabled: false` or `--no-supply-chain` to skip |
| `projects` | per-package scoring in a monorepo |

Do not use `ignore` to hide a real bug. Prefer fixing the code; use a narrow override with a comment when the rule is genuinely inapplicable.

## CI

CLI gate:

```yaml
- name: React Doctor
  run: pnpm dlx react-doctor@latest --scope changed --base origin/main --blocking error --no-telemetry
```

Or scaffold a workflow:

```bash
vp dlx react-doctor@latest ci install
```

The GitHub Action supports `blocking`, `scope`, `comment`, `review-comments`, `commit-status`, and `version`; use it if you want PR comments and a commit status instead of a raw CLI step.

## Runtime traces

```bash
vp dlx react-doctor@latest scan http://localhost:5173
```

It records a Chrome DevTools performance trace while you interact with the app, then writes a trace summary. Use `--format json` for agents. This is optional; the static scan is mandatory.

## Stack-specific noise

Vendored shadcn source and route files can produce expected warnings:

| Finding | Where | Action |
|---|---|---|
| `react/only-export-components` | `src/routes/**` (exports `Route` + component), `src/components/ui/**` (exports variants) | narrow `ignore.overrides`, not a global rule off |
| `react-doctor/only-export-components` | `src/components/ui/**` | same |
| `react-doctor/no-array-index-as-key` | generated `field.tsx` / table code | fix if the list is dynamic; otherwise narrow override |
| `anchor-ambiguous-text` | demo copy like “Learn more” | add an `aria-label` or clearer link text |

```ts
// doctor.config.ts
import { defineConfig } from 'react-doctor/api'

export default defineConfig({
  ignore: {
    overrides: [
      {
        files: ['src/components/ui/**', 'src/routes/**'],
        rules: [
          'react/only-export-components',
          'react-doctor/only-export-components',
        ],
      },
    ],
  },
})
```

Do not suppress categories. Suppress the smallest rule/file set and leave a reason.

## Practical notes

- **Telemetry:** crash reports and anonymous usage are on by default. Always pass `--no-telemetry` in this skill, CI, and agent runs. It implies `--no-score`, so the score is not printed. To get a numeric score, run `--score` by itself (it uses the score API); `--score` cannot be combined with `--no-telemetry`. `--no-score` also disables the score API/share/crash reporting while keeping diagnostics.
- **Supply chain:** the Socket.dev check needs network access. If it is blocked, use `--no-supply-chain`; do not disable it permanently.
- **Time budget:** `--max-duration <seconds>` reports partial results instead of hanging CI.
- **Score is not the goal:** a high score with suppressed real issues is worse than a lower score with a clear fix list. Report errors first.
- **Do not install the React Doctor agent skill** (`react-doctor install`) when this skill is already installed; it duplicates the workflow. Use the CLI directly.

## Baseline workflow for this stack

```bash
vp build
vp check --fix
vp test
vp dlx react-doctor@latest --no-telemetry --verbose
```

Fix errors, triage warnings, then re-run until the error count is 0. For a PR, also run the changed-scope gate with `--blocking error`.

## Sources

- Docs: https://react.doctor/docs
- CLI reference: https://react.doctor/docs/reference/cli-reference
- Config: https://react.doctor/docs/configuration/config-files
- Repository: https://github.com/millionco/react-doctor
