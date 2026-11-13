# Skills Hub

Claude Code skills for a React frontend and a Go backend.

| Skill | Use |
|---|---|
| `react-frontend-stack` | React 19 + Vite+ + shadcn/ui + Tailwind v4 + TanStack (Router, Query, Table, Form, Virtual, Store) + Kubai Icons + React Doctor |
| `go-backend` | Go services and admin APIs: pprof/benchmarks, concurrency, graceful shutdown/Kubernetes, library selection, Huma/chi, pgx/sqlc, auth/RBAC, audit |

## Install

### One project

Copy the skill folder into the project:

```bash
mkdir -p .claude/skills
cp -R react-frontend-stack .claude/skills/
cp -R go-backend .claude/skills/
```

Windows PowerShell:

```powershell
$dst = "D:\path\to\project\.claude\skills"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item .\react-frontend-stack, .\go-backend $dst -Recurse -Force
```

### All projects on one machine

```bash
mkdir -p ~/.claude/skills
cp -R react-frontend-stack go-backend ~/.claude/skills/
```

Windows PowerShell:

```powershell
$dst = "$env:USERPROFILE\.claude\skills"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item .\react-frontend-stack, .\go-backend $dst -Recurse -Force
```

Verify with `/skills` in Claude Code.

## Structure

```text
<project>/.claude/skills/
├── react-frontend-stack/
│   ├── SKILL.md
│   ├── references/
│   └── scripts/check-stack.mjs
└── go-backend/
    ├── SKILL.md
    └── references/
```

Keep each `SKILL.md` inside its own named folder. Do not place `SKILL.md` directly under `.claude/skills/`.

## Notes

- The skills are instructions for coding agents, not runtime dependencies. The project still needs Node/Vite+ or Go installed.
- `react-frontend-stack` requires Vite+ (`vp`) and runs `vp dlx react-doctor@latest --no-telemetry`.
- The Go performance and shutdown references are derived notes and keep their original source headers. Check redistribution terms before publishing outside your team.
- No license is included yet; add one if you want others to reuse this material.
