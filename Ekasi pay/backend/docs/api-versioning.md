# API versioning

## Current surface (`/api` — v0 compatibility)

Clients (merchant app, Capacitor builds, ops static UI) call paths under
**`/api/...`**. That mount is the **v0 compatibility surface**: stable enough for
current integrations, but not a long-term version contract. Breaking changes
must be staged behind a versioned prefix before removing unversioned routes.

## Planned and implemented alias (`/api/v1`)

The Express app mounts the **same router** at both prefixes:

```text
app.use('/api/v1', api);
app.use('/api', api);
```

- `/api/v1/*` is the preferred path for new clients and documentation.
- `/api/*` remains until a documented deprecation window expires.
- No duplicate business logic: both mounts share one `api` router instance.

Health probes stay outside the versioned API: `/health`, `/health/live`,
`/health/ready`.

## Migration strategy (when breaking changes appear)

1. Add or change behaviour only under `/api/v1` when a change would break
   existing `/api` clients.
2. Publish a deprecation notice (changelog + client `X-API-Warn` or docs) with
   an end date for unversioned `/api` behaviour that diverges.
3. Update Vite proxy, `VITE_API_URL` consumers, and ops `runtime-config.js` to
   prefer `/api/v1` when ready.
4. After the window, either keep `/api` as a thin redirect/alias to `/api/v1`
   or remove routes that no longer match v1 — never silently change money
   semantics on the unversioned mount without a release note.

## Non-goals

- This document does not invent OpenAPI generation or public partner APIs.
- Path versioning does not replace product feature flags or Phase 7 readiness
  evidence for regulated money movement.
