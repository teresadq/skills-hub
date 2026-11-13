---
name: go-backend
description: Build, review, and optimize Go backend services, especially admin systems. Covers pprof and benchmarks, memory and goroutine leaks, concurrency, context and error handling, graceful shutdown on SIGTERM/Kubernetes, library selection, project layout, and Go admin API design with Huma/chi, pgx/sqlc, session auth, RBAC, pagination, audit, async jobs, and OpenAPI-to-TypeScript clients. Use when the user mentions Go, Golang, pprof, benchmark, goroutine 泄漏, 优雅关闭, SIGTERM, K8s 滚动发布, 选库, Go 项目结构, Go 后台管理系统, or asks to review or optimize Go code.
---

# Go Backend

Default stack for a Go admin backend:

| Concern | Choice |
|---|---|
| HTTP / routing | `net/http` (Go 1.22+ patterns) or `chi` |
| OpenAPI | **Huma** on top of `chi` / `net/http` |
| Database | PostgreSQL + `pgx` + `sqlc` |
| Migrations | `goose` or `atlas` |
| Auth | HttpOnly session (`scs`) + CSRF; `/api/me` for permissions |
| RBAC | Casbin, or `user_roles` / `role_permissions` tables |
| Background jobs | River (Postgres) or Asynq (Redis) |
| Config | env + `koanf` |
| Logging | `log/slog` + request ID |
| Observability | OpenTelemetry + Prometheus |
| Tests | `httptest` + `testcontainers-go` |
| TS client | OpenAPI → Orval / `openapi-typescript` |

Do not introduce a microservice framework, Kubernetes operator, or message broker until the monolith actually needs it.

## Read the right reference

- Performance, pprof, benchmarks, memory, concurrency, language traps → `references/go-performance-agent-guide.md`
- Graceful shutdown, SIGTERM, Kubernetes probes/preStop/grace period → `references/go-graceful-shutdown-k8s.md`
- Library selection, context/error/style tips, project layout, testing → `references/go-libraries-and-tips.md`
- Go admin API contract, auth/RBAC, pagination, audit, async jobs → `references/admin-api.md`

Read only what the task needs. The performance guide is the largest; use its §0–§1 and §8 decision table first.

## Ten rules

1. **Measure before optimizing.** No profile or benchmark evidence means no hot-path change.
2. **Change one variable at a time.** Keep a baseline; make each change independently revertible.
3. **Preserve observable behavior.** Concurrency changes must pass `go test -race`.
4. **Context first.** Blocking DB, HTTP, RPC, and queue calls take `context.Context`; no `context.Background()` in business calls.
5. **Every goroutine must be able to exit.** Define the channel owner, cancellation, and timeout path.
6. **Handle or return every error.** Library code must not `log.Fatal`, `os.Exit`, or silently swallow.
7. **Close resources in reverse order.** Stop ingress → wait for in-flight work → close DB/cache; let `defer` run.
8. **Standard library first.** Before adding a dependency, check maintenance, license, Go version, and context support.
9. **No unverifiable hacks.** `unsafe`, reflection, and code generation need tests, comments, and a rollback plan.
10. **Verify before delivery.** `gofmt`, `go vet`, `go test -race ./...`, `go build ./...`; performance changes need `benchstat`.

## Workflow

### 1. Detect the project

```bash
go version
go env GOOS GOARCH GOMAXPROCS
cat go.mod
```

Read `cmd/`, `internal/`, and existing handler/service/repo boundaries before proposing a layout.

### 2. Establish a baseline

```bash
gofmt -l .
go vet ./...
go test ./...
go build ./...
govulncheck ./...
```

For performance work:

```bash
go test -run '^$' -bench . -benchmem -count=10 ./... > old.txt
```

### 3. Change one thing

- Bug fix: write a failing test first.
- Performance: state the hypothesis in one sentence, then change only the corresponding code.
- API: define the contract before the handler.

### 4. Verify

```bash
gofmt -w .
go vet ./...
go test -race ./...
go build ./...
govulncheck ./...
```

Performance changes:

```bash
go test -run '^$' -bench . -benchmem -count=10 ./... > new.txt
benchstat old.txt new.txt
```

Lifecycle changes: exercise SIGTERM / `Shutdown` with an in-flight request and a background consumer.

### 5. Report

State:

- what rule / reference you followed
- files and behavior changed
- commands run and results
- concurrency, compatibility, performance, and rollback risks
- anything not verified

## Admin API contract

Use `references/admin-api.md` for the full version. Minimum:

- OpenAPI-first; generate the TypeScript client, don't hand-write API types.
- Consistent envelope: `items`, `page`, `pageSize`, `total`.
- Stable error code + message + request ID:
  ```json
  { "code": "USER_EMAIL_EXISTS", "message": "邮箱已存在", "details": { "field": "email" }, "requestId": "req_xxx" }
  ```
- HttpOnly session + CSRF; JWT in localStorage is not acceptable for admin.
- `/api/me` returns user, roles, permission codes, and menu tree.
- Backend enforces every permission; frontend only hides controls.
- Audit fields: `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at`.
- Optimistic concurrency: `version` or `If-Match`; return 409 on conflict.
- Bulk/import/export: async job + progress (SSE or polling).
- Uploads: S3/MinIO presigned URL, not a Go proxy for large files.

## Project layout

```text
cmd/server/main.go
internal/
  httpapi/        # routes, middleware, request/response mapping
  service/        # business rules
  repo/           # pgx/sqlc queries
  domain/         # entities, errors, permission codes
  platform/       # config, db, logger, telemetry
migrations/
```

- `httpapi` may import `service`; `service` may import `repo` and `domain`; never the reverse.
- Do not leak `chi`, `huma`, `pgx`, or `sqlc` types into `domain`.
- Keep `main.go` to wiring, config, signal handling, and shutdown.

## Command cheat sheet

| Need | Command |
|---|---|
| Format | `gofmt -w .` |
| Vet | `go vet ./...` |
| Race tests | `go test -race ./...` |
| Build | `go build ./...` |
| Vuln scan | `govulncheck ./...` |
| Benchmark baseline | `go test -run '^$' -bench . -benchmem -count=10 ./...` |
| Compare | `benchstat old.txt new.txt` |
| CPU profile | `go test -bench . -cpuprofile cpu.out` |
| Profile UI | `go tool pprof -http=:9999 cpu.out` |
| Goroutine dump | `curl localhost:6060/debug/pprof/goroutine?debug=2` |
| Dependency graph | `go mod graph` |

## Testing

- Table-driven unit tests for domain/service.
- `httptest` for handlers; assert status, envelope, and error code.
- `testcontainers-go` for Postgres/Redis integration tests.
- `go test -race` for anything concurrent.
- Fake the clock and random source where behavior depends on them.
- Do not assert on log text; assert on returned errors and observable state.

## Known gotchas

- `defer` inside a loop keeps resources until function return; wrap the iteration in a function.
- `http.Client` without `Timeout` can hang forever; reuse one client/Transport.
- `time.After` in a hot loop allocates; use `time.NewTimer` and stop it.
- A goroutine reading from a channel without a `done` path leaks on shutdown.
- Slices returned from a large backing array retain the whole array; copy when needed.
- A typed nil interface is not `nil`; return `nil` explicitly.
- `http.Server.Shutdown` does not close hijacked connections (WebSocket) or wait for `ListenAndServe` to return unless handled.
- `ErrServerClosed` is normal after `Shutdown`, not an error to report.
- K8s `preStop` time counts toward `terminationGracePeriodSeconds`; readiness removal is asynchronous.
- `govulncheck` needs network access; run it in CI with a pinned Go version.
- Go version in `go.mod` is a compatibility contract; don't bump it casually in a shared module.

## Sources

- Performance: `references/go-performance-agent-guide.md` (derived from 极客兔兔《Go 语言高性能编程》 and pprof articles; see file header)
- Graceful shutdown: `references/go-graceful-shutdown-k8s.md` (derived from VictoriaMetrics and Kubernetes semantics)
- Libraries: `references/go-libraries-and-tips.md`
- Admin API: `references/admin-api.md`

The performance and shutdown references are derived notes with their original source headers. Keep those headers and check redistribution terms before sharing the skill outside your team.
