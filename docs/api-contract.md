# FleetFlow API contract (v1)

Development base URL: `http://localhost:3000`. Protected routes use `Authorization: Bearer <accessToken>`.

Access tokens expire after 15 minutes. Refresh tokens rotate on every successful refresh; replaying a rotated token revokes its token family. Native clients send refresh tokens in the request body. The dashboard uses an HttpOnly, SameSite cookie and keeps its access token in memory.

## Status codes

- `200` successful read/update or idempotent duplicate
- `201` resource created or a batch accepted at least one new ping
- `202` asynchronous export accepted
- `204` successful deletion with no response body
- `401` missing, expired, or invalid authentication
- `403` authenticated but not authorized for the role/resource
- `404` resource not found
- `409` state or uniqueness conflict
- `410` generated export artifact has expired
- `422` validation failure: `{ "error": "ValidationError", "details": [{ "path": "...", "message": "..." }] }`
- `429` rate limited; includes `Retry-After`

## Authentication

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | Public | Creates a `DRIVER`; role elevation is never self-service |
| POST | `/api/auth/login` | Public | Limited to 10 requests/minute/IP |
| POST | `/api/auth/refresh` | Public with refresh token | Rotates the refresh token |
| POST | `/api/auth/logout` | Public with refresh token | Revokes the server-side token |
| GET | `/api/auth/me` | Any authenticated user | Current identity |
| POST | `/api/auth/forgot-password` | Public | Always returns `202` to prevent account enumeration |
| POST | `/api/auth/reset-password` | Public with reset token | Single-use reset and session revocation |
| POST | `/api/auth/invite` | Admin | Creates an admin/manager invitation |
| POST | `/api/auth/accept-invite` | Public with invite token | Accepts a single-use invitation |

## Vehicles and trips

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/vehicles` | Any authenticated user | Drivers receive only usable/assigned vehicles; fleet roles receive the active fleet |
| POST | `/api/vehicles` | Manager, admin | Creates a unique plate/model |
| PATCH | `/api/vehicles/:id` | Manager, admin | Updates plate, model, status, default driver, or maintenance note |
| DELETE | `/api/vehicles/:id` | Manager, admin | Soft deletes the vehicle; history remains readable |
| GET | `/api/trips` | Any authenticated user | Drivers are scoped to their own trips; filters: `status`, `driverId`, `page`, `pageSize` |
| POST | `/api/trips` | Driver | Starts one trip for `{ "vehicleId": number }` |
| GET | `/api/trips/:tripId` | Owner, manager, admin | Includes ordered location pings |
| GET | `/api/trips/:tripId/stats` | Owner, manager, admin | Computes distance, speed, and duration statistics |
| POST | `/api/trips/:tripId/pings` | Owning driver | One idempotent location ping |
| POST | `/api/trips/:tripId/pings/batch` | Owning driver | Up to 500 pings; returns accepted, duplicate, and failed-item results |
| POST | `/api/trips/:tripId/finish` | Owner, manager, admin | Completes the trip and persists statistics |
| GET/POST | `/api/trips/export` | Manager, admin | Alias for listing/requesting export jobs |

Every ping includes a UUID `idempotencyKey`, latitude/longitude, speed, heading, accuracy, and `recordedAt`. Duplicate single pings return `200` with `duplicate: true`. A batch returns `201` when it accepts at least one new ping and `200` when all items are duplicates.

## Alerts and geofences

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/alerts` | Any authenticated user | Drivers are resource-scoped; filters include `status`, `type`, and pagination |
| POST | `/api/alerts` | Any authenticated user | Types: `SOS`, `HARSH_BRAKING`, `OVERSPEED`, `GEOFENCE_ENTER`, `GEOFENCE_EXIT`, `CRASH_DETECTED` |
| PATCH | `/api/alerts/:id` | Manager, admin | Moves an alert to `ACKNOWLEDGED` or `RESOLVED` and records triage metadata |
| GET | `/api/geofences` | Any authenticated user | Active geofences |
| POST | `/api/geofences` | Manager, admin | Creates a circular fence with optional enter/exit alerts |
| PATCH | `/api/geofences/:id` | Manager, admin | Updates geometry, name, active state, and alert flags |
| DELETE | `/api/geofences/:id` | Manager, admin | Disables the fence while retaining its history |
| GET | `/api/geofences/:id/history` | Manager, admin | Filters: `vehicleId`, `eventType`, `from`, `to`, `page`, `pageSize` |
| POST | `/api/geofences/check` | Any authenticated user | Returns distance/inside decisions for `{ "lat", "lng" }` |

Geofence transitions are evaluated asynchronously from synchronized pings. Per-vehicle locking and chronological guards prevent duplicate or stale transition state.

## Users and preferences

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/users/me/notification-prefs` | Any authenticated user | Returns effective alert preferences |
| PATCH | `/api/users/me/notification-prefs` | Any authenticated user | Updates `{ "prefs": [{ "type", "enabled" }] }` |
| POST | `/api/users/me/device-tokens` | Any authenticated user | Idempotently registers a push token |
| DELETE | `/api/users/me/device-tokens/:token` | Any authenticated user | Unregisters a push token |
| GET | `/api/users-admin` | Manager, admin | Paginated/searchable fleet directory |
| POST | `/api/users-admin` | Admin | Directly provisions a driver with name, email, and temporary password |
| GET | `/api/users-admin/:id` | Manager, admin | User details |
| PATCH | `/api/users-admin/:id` | Admin | Updates name/role or deactivates/reactivates the account |
| GET | `/api/users-admin/:id/audit` | Admin | Audit entries for one user |
| GET | `/api/audit-logs` | Admin | Filters: `action`, `actorId`, `q`, `page`, `pageSize` |

SOS notifications cannot be disabled. Other alert preferences are applied per recipient.

## Exports

The same export router is available at `/api/reports` and `/api/exports`; `/api/trips/export` is an additional alias.

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| POST | `/api/reports` | Manager, admin | Enqueues `TRIPS_CSV`, `ALERTS_CSV`, or `GEOFENCE_HISTORY`; returns `202` |
| GET | `/api/reports` | Manager, admin | Lists the caller's recent jobs |
| GET | `/api/reports/:jobId` | Manager, admin | Polls job status |
| GET | `/api/reports/:jobId/download` | Manager, admin | Downloads a completed CSV |

## Health, metrics, and background jobs

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | Returns `{ ok, db, redis, ts }` |
| GET | `/api/metrics` | Public or bearer token | Requires `METRICS_TOKEN` when configured |

BullMQ workers handle geofence evaluation, notifications, CSV generation, partition maintenance, retention, and stale-trip recovery. An active trip with no new ping for `STALE_TRIP_HOURS` is cancelled, audited as `TRIP_REAPED`, removed from the live-position view, and broadcast as finished. Set the value to `0` to disable the reaper.

## WebSocket (`/ws`)

After connection, send:

```json
{"type":"auth","token":"<accessToken>"}
```

The legacy `?token=` query is also accepted. Authorized clients can subscribe to `fleet:all`, `driver:<id>`, or `vehicle:<id>` topics within their role scope.

Server events include `auth_ok`, `hello`, `location`, `location_batch`, `alert`, `alert_updated`, `geofence_event`, `trip_started`, and `trip_finished`. Each event includes an ISO timestamp. The server uses WebSocket ping/pong heartbeats every 30 seconds.

## Mobile synchronization contract

The Android client writes location fixes to Room before attempting network delivery. It sends up to 500 queued records per batch in chronological chunks. Successful or duplicate items are removed locally; failed items remain annotated for retry. This provides at-least-once transport with idempotent server-side effects.
