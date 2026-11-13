# Go Admin API

Contract and implementation defaults for an admin backend consumed by a React + TanStack frontend.

## Contract first

Define the OpenAPI document before the handler. Use **Huma** on `chi` or `net/http`; it generates OpenAPI 3.1 from Go types.

```go
router := chi.NewRouter()
api := humachi.New(router, huma.DefaultConfig("Admin API", "1.0.0"))

huma.Register(api, huma.Operation{
    OperationID: "list-users",
    Method:      http.MethodGet,
    Path:        "/api/users",
}, listUsers)
```

Then generate the frontend client instead of hand-writing types:

```bash
vp dlx orval --config orval.config.ts
# or
vp dlx openapi-typescript ./openapi.json -o src/api/schema.d.ts
```

Generated code belongs in `src/api/generated/` and is not edited by hand.

## Response envelope

Paged list:

```json
{
  "items": [],
  "page": 1,
  "pageSize": 20,
  "total": 135
}
```

Single object: return the object directly; do not wrap it in `data` unless the whole API uses that convention.

Errors:

```json
{
  "code": "USER_EMAIL_EXISTS",
  "message": "邮箱已存在",
  "details": { "field": "email" },
  "requestId": "req_01J..."
}
```

Rules:

- HTTP status expresses the class; `code` is stable and machine-readable.
- `message` is safe to show to an operator; do not leak SQL, stack traces, or internal paths.
- `details` carries field errors for forms.
- `requestId` comes from middleware and is also returned in the `X-Request-ID` header.
- Validation errors use 422; auth uses 401; permission uses 403; missing uses 404; conflict uses 409.

## Auth and session

For an admin app, prefer a server session over a JWT in browser storage.

```go
sessions := scs.New()
sessions.Lifetime = 12 * time.Hour
sessions.Cookie.HttpOnly = true
sessions.Cookie.Secure = true
sessions.Cookie.SameSite = http.SameSiteLaxMode
```

- Session ID in an HttpOnly, Secure, SameSite cookie.
- CSRF protection for state-changing requests (double-submit cookie or `gorilla/csrf`).
- Rotate the session ID on login; revoke on logout and password change.
- Rate-limit login by IP + account; log failures without passwords.
- If the frontend and API are on different origins, use an explicit CORS allowlist and `SameSite=None; Secure` only when required.

Do not use `localStorage` for access tokens in an admin system.

## Permissions

`GET /api/me`:

```json
{
  "user": { "id": "u_1", "name": "Ada", "email": "ada@example.com" },
  "roles": ["admin"],
  "permissions": ["user:read", "user:create", "audit:read"],
  "menus": []
}
```

- Backend enforces every permission; frontend only hides controls.
- Permission codes are stable: `resource:action`, e.g. `user:create`, `order:refund`.
- Implement `RequirePermission("user:create")` middleware and apply it per route, not only per router group.
- Tenant-scoped resources must include the tenant ID in every query; never trust a tenant ID from the request body.
- Tests must cover 401, 403, cross-tenant access, and a user with no roles.

Casbin is fine for complex policies; a small `user_roles` / `role_permissions` schema is enough for most admin systems.

## Pagination, sorting, filtering

Query contract:

```text
?page=1&pageSize=20&sort=created_at&order=desc&q=ada&status=active
```

- Validate `page >= 1`, `1 <= pageSize <= 100`.
- Sort fields come from a whitelist; never interpolate user input into SQL.
- Return `total`; for very large tables add cursor pagination (`cursor`, `nextCursor`) and keep offset for small tables.
- Put filters in URL search params on the frontend so they survive reload and sharing.
- Use `COUNT(*) OVER()` or a separate count query; measure before choosing.

## Audit and concurrency

Every mutable admin table:

```text
id, created_at, updated_at, created_by, updated_by, deleted_at
```

- Soft delete by default for business records; hard delete only for explicit purge flows.
- Write an `audit_logs` row for create/update/delete/status changes: actor, action, object type, object ID, before/after diff, IP, user agent, request ID.
- Do not put secrets or full request bodies in the audit log.
- Optimistic concurrency: `version` integer or `If-Match`; update with `WHERE id = $1 AND version = $2`; return 409 with the current version on mismatch.

Idempotency for retried mutations:

```text
Idempotency-Key: <client-generated UUID>
```

Store the key + response hash with a TTL; replay the same response for the same key.

## Async work, imports, exports

- Use River (Postgres) or Asynq (Redis) for report exports, imports, bulk updates, and email.
- API returns `202 Accepted` with a job ID:
  ```json
  { "jobId": "job_123", "status": "queued" }
  ```
- Frontend polls `GET /api/jobs/{id}` or subscribes to SSE.
- Job handlers must be idempotent and retry-safe.
- For large exports, write to object storage and return a short-lived presigned URL.
- For uploads, issue a presigned S3/MinIO URL; do not proxy large files through Go.

## Database

- `pgx` + `sqlc` by default: explicit SQL, generated row types, no ORM magic in hot paths.
- GORM is acceptable only if the team already uses it; keep complex queries in SQL.
- Every query takes `context.Context`.
- Set pool limits (`MaxConns`, `MinConns`, `MaxConnLifetime`) from configuration.
- Use transactions for multi-table invariants; keep them short; never hold a transaction across an HTTP call.
- Migrations are forward-only and reviewed; never edit applied migrations.

## Middleware order

```text
request ID -> recover -> access log -> security headers -> CORS
-> session -> CSRF -> auth -> permission -> handler
```

- Recover turns panics into 500 with a request ID; never leak the stack to the client.
- Access log includes method, route, status, duration, request ID, user ID; not passwords or tokens.
- Health endpoints: `/healthz` (process) and `/readyz` (DB/cache dependencies). Keep them outside auth.

## Graceful shutdown

Follow `references/go-graceful-shutdown-k8s.md`.

- Stop readiness first; wait for endpoint propagation.
- `http.Server.Shutdown(ctx)` with a timeout.
- Stop queue consumers, then flush producers, then close DB/cache.
- `preStop` time counts toward `terminationGracePeriodSeconds`.
- Treat `http.ErrServerClosed` as normal.

## Testing

- `httptest` for handler/status/envelope/error-code tests.
- `testcontainers-go` for Postgres/Redis integration tests.
- `go test -race ./...` for concurrent code.
- Seed permissions and users explicitly; do not share global DB state between tests.
- Contract test: validate the generated OpenAPI against the frontend client build.

## Checklist

- [ ] OpenAPI generated; TypeScript client generated, not hand-written
- [ ] `/api/me` returns roles + permission codes
- [ ] Every route has auth + permission middleware
- [ ] Error envelope has stable `code` and `requestId`
- [ ] Pagination/sort/filter validated and whitelisted
- [ ] Audit fields + audit log for mutations
- [ ] `version` / `If-Match` for editable records
- [ ] Idempotency key for retried mutations
- [ ] Graceful shutdown tested with in-flight work
- [ ] `go test -race ./...`, `go vet ./...`, `govulncheck ./...` pass
- [ ] No secrets in logs, errors, or audit diffs
