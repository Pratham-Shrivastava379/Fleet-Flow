# FleetFlow

FleetFlow is a full-stack fleet operations and driver-safety platform. It combines a native Android app, a Node.js API and worker, a React operations dashboard, PostgreSQL/PostGIS, Redis, real-time updates, and an offline-first location pipeline.

The project is designed as a production-style engineering portfolio: it includes role-based access control, secure token rotation, background processing, observability, automated tests, container builds, CI/CD workflows, and Kubernetes deployment assets.

## Demo video

<!-- Replace the line below with your public YouTube, Google Drive, Loom, or GitHub Release link. -->

**Demo video:** https://youtube.com/shorts/uELxEp4fhrw

**Tracking Demo:** https://youtube.com/shorts/ycS2A5Fge2k

## Highlights

- **Offline-first tracking:** Android stores every location fix in Room before upload. WorkManager retries connectivity failures and sends ordered, idempotent batches when the device reconnects.
- **Driver experience:** vehicle selection, trip start/finish, background tracking, live route map, SOS, alerts, trip history, animated route replay, notification preferences, and secure session restoration.
- **Manager and admin operations:** live fleet map, alert triage, trip search and CSV exports, vehicle management, geofence management and history, team management, and audit logs.
- **Real-time backend:** REST APIs, authenticated WebSockets, Redis pub/sub, BullMQ workers, PostGIS geofence evaluation, stale-trip recovery, rate limiting, and structured audit events.
- **Production tooling:** Docker Compose, GitHub Actions, Android release automation, Kubernetes manifests, Prometheus, Grafana, OpenTelemetry/Jaeger, Sentry integration points, and environment-injected secrets.

## Architecture

```text
Android app -------- REST/JWT --------+
                                      |
React dashboard ---- REST/WebSocket --+--> Express API --> Prisma --> PostgreSQL/PostGIS
                                                |
                                                +--> Redis pub/sub
                                                +--> BullMQ workers
                                                +--> Prometheus metrics

OpenTelemetry traces -------------------------------> Jaeger
Prometheus metrics ---------------------------------> Grafana
```

### Component boundaries

| Component | Responsibility |
| --- | --- |
| Android app | Driver trips, background location capture, offline queue, SOS, alerts, history, replay, and notification preferences |
| React dashboard | Live fleet monitoring, alert triage, trips and exports, vehicles, geofences, users, and audit logs |
| Express API | Authentication, RBAC, validation, business workflows, REST contracts, and WebSocket authorization |
| PostgreSQL/PostGIS | Durable fleet data, trip history, location partitions, statistics, geospatial queries, and audit records |
| Redis | Shared rate limiting, cross-instance pub/sub, and BullMQ queue transport |

The backend is a modular monolith: routes validate and authorize requests, services implement business rules, and Prisma provides data access. PostgreSQL remains the source of truth; WebSocket messages accelerate UI updates but never replace REST reconciliation.

### Offline tracking and synchronization

```text
Fused Location Provider
        |
        v
Android foreground service --> Room queue --> immediate sync attempt
                                      |
                         connectivity unavailable
                                      |
                                      v
                        WorkManager network-constrained retry
                                      |
                                      v
                         ordered batches of up to 500
                                      |
                                      v
                     Express API --> PostgreSQL/PostGIS
```

Each ping is stored locally before upload and carries a client-generated UUID. The backend records that key in a unique deduplication table, making retries safe when a mobile connection fails after the server has already accepted a request. Batches are sorted by their original recording time so delayed uploads cannot scramble the route. Successful and duplicate points are removed from Room; failed points remain annotated for retry.

### Real-time and background processing

```text
REST write --> PostgreSQL commit --> Redis fleet event --> authorized WebSocket clients
                         |
                         +--> BullMQ job --> worker --> geofence/notification/export result
```

WebSocket subscriptions are role-scoped to fleet, driver, or vehicle topics and are revalidated against the database when authority changes. Redis pub/sub carries events across API instances. Five BullMQ queues isolate geofence evaluation, notifications, exports, retention, and partition maintenance from request latency.

### Data and geospatial design

- The Prisma schema contains users, refresh-token families, vehicles, trips, location pings, alerts, geofences, notification preferences, device tokens, exports, audit records, and live vehicle positions.
- Location pings are range-partitioned by month and indexed by trip and recording time.
- PostGIS generated geography columns and GiST indexes support server-authoritative fence containment and transition evaluation.
- Trip distance and speed statistics are calculated from ordered pings using PostgreSQL window functions and `ST_DistanceSphere`.
- Vehicles and geofences use soft-deactivation semantics so historical trips and compliance events remain readable.

### Security and reliability

- Public registration creates drivers only; administrator and manager elevation uses controlled administration/invitation flows.
- Passwords use bcrypt, access tokens are short-lived, and hashed refresh tokens rotate in families. Replaying a rotated token revokes the family.
- The dashboard receives refresh tokens through HttpOnly, SameSite cookies and keeps access tokens in memory; Android stores session tokens using encrypted preferences.
- RBAC and resource ownership are enforced by the backend for both REST and WebSocket operations.
- Validation, bounded request bodies, CORS allow-listing, Helmet headers, Redis-backed rate limiting, request IDs, audit logs, health probes, and stale-trip recovery cover common failure paths.

### Deployment and observability

Docker Compose runs PostgreSQL/PostGIS, Redis, the API, worker, Prometheus, Grafana, and Jaeger locally. Production assets include separate API, worker, migration, and dashboard images plus Kubernetes Deployments, Services, Ingress/TLS, health probes, autoscaling, a disruption budget, configuration, secrets templates, and persistent export storage.

The API and worker expose Prometheus counters, gauges, and latency histograms. Grafana is provisioned with panels for request rate, error rate, p50/p95 latency, queue depth, worker throughput, WebSocket connections, and database health. OpenTelemetry exports HTTP and business-operation spans to Jaeger when tracing is configured.

## Technology stack

| Area | Technologies |
| --- | --- |
| Android | Kotlin, Jetpack Compose, MVVM, Hilt, Coroutines, Room, WorkManager, Retrofit, Fused Location Provider, Google Maps Compose, FCM |
| Backend | Node.js 22, Express, Prisma, PostgreSQL 16, PostGIS, Redis, BullMQ, WebSockets, Zod |
| Dashboard | React 18, TypeScript, Vite, TanStack Query, Leaflet/OpenStreetMap, optional Google Maps |
| Operations | Docker, Kubernetes, GitHub Actions, Prometheus, Grafana, OpenTelemetry, Jaeger, Sentry |

## Role capabilities

| Capability | Driver | Fleet manager | Admin |
| --- | :---: | :---: | :---: |
| Start, track, and finish own trips | Yes | No | No |
| View permitted trips and alerts | Own | Fleet | Fleet |
| Use live fleet map | No | Yes | Yes |
| Manage vehicles and geofences | No | Yes | Yes |
| Export trip, alert, and geofence data | No | Yes | Yes |
| Add, edit, or deactivate drivers | No | No | Yes |
| View security audit logs | No | No | Yes |

RBAC is enforced by the API. Hiding controls in a client is not treated as authorization.

## Safety-event scope

FleetFlow supports `SOS`, `HARSH_BRAKING`, `OVERSPEED`, `GEOFENCE_ENTER`, `GEOFENCE_EXIT`, and `CRASH_DETECTED` alert records and notification preferences.

- SOS is fully wired from the driver app through alert delivery and manager triage.
- Geofence entry and exit are evaluated server-side from synchronized location pings using PostGIS.
- Harsh braking uses a conservative on-device **candidate detector** that combines filtered accelerometer data with a speed drop. Its thresholds require calibration against real vehicles and phone mounting positions before operational use.
- Overspeed and crash alert types are extension points in the current build; there is no production-validated automatic detector for them yet.

That distinction is intentional: the data model and workflows are ready without presenting uncalibrated heuristics as safety-certified detection.

## Repository layout

```text
android/                  Native Android application and tests
backend/                  API, worker, Prisma schema, migrations, seeds, and tests
dashboard/                React operations dashboard and tests
deploy/                   Local observability, staging, and Kubernetes assets
docs/                     API contract and archived engineering history
.github/workflows/        CI, E2E, deployment, and Android release workflows
```

## Local setup

### Prerequisites

- Docker Desktop with Docker Compose
- Node.js 22+
- JDK 17+
- Android Studio or an Android SDK with an emulator/device
- A Google Maps Android API key only if you want live map tiles on Android

### 1. Start data services

```bash
docker compose up -d postgres redis
```

### 2. Migrate and seed the database

```bash
cd backend
npm ci
npx prisma generate
npx prisma migrate deploy
node scripts/seed-dev-demo.mjs
cd ..
```

The development seed is idempotent and refuses to run in production. It creates Indian demo identities, two vehicles, two Bengaluru geofences, a completed trip, location pings, and a resolved alert.

| Role | Name | Email | Password |
| --- | --- | --- | --- |
| Admin | Aditi Sharma | `admin@fleetflow.dev` | `Adminpass1` |
| Fleet manager | Priya Nair | `manager@fleetflow.dev` | `Managerpass1` |
| Driver | Ravi Kumar | `driver@fleetflow.dev` | `Driverpass1` |

Demo vehicles: `KA-01-DEMO` (Tata Ace Gold) and `KA-05-DEMO` (Mahindra Bolero Pik-Up).

These credentials are for local development only. Override them with the documented `SEED_*` environment variables when needed.

### 3. Start the API, worker, and observability services

```bash
docker compose up -d --build api worker prometheus grafana jaeger
```

Available services:

| Service | URL |
| --- | --- |
| API health | `http://localhost:3000/api/health` |
| Grafana | `http://localhost:3001` |
| Prometheus | `http://localhost:9090` |
| Jaeger | `http://localhost:16686` |

### 4. Start the dashboard

```bash
cd dashboard
npm ci
npm run dev
```

Open `http://localhost:5173` and sign in as the manager or admin. Vite proxies `/api` and `/ws` to the local backend, preserving the same-site web authentication flow.

### 5. Run Android

Create `android/local.properties` and do not commit it:

```properties
sdk.dir=C:/path/to/Android/Sdk
GOOGLE_MAPS_KEY=your_android_maps_key
```

The maps key is optional for builds; the app shows a provider-neutral fallback without one. For a physical USB device, expose the host API to the device before installing:

```bash
adb reverse tcp:3000 tcp:3000
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Sign in with the driver account, select a vehicle, grant notification and location permissions, and start a trip. The debug app connects to `http://127.0.0.1:3000`.

## Verification

```bash
cd backend
npm test
npm run lint
npm run format:check

cd ../dashboard
npm test
npm run lint
npm run build
npm run format:check

cd ../android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

The scheduled Android workflow runs `connectedDebugAndroidTest` on an emulator. Full-stack browser/API verification is covered by the scheduled E2E workflow.

## Optional integrations

The repository contains no production credentials. Integrations remain inactive until configured:

- Android Maps: `GOOGLE_MAPS_KEY` in `android/local.properties`
- Android FCM: `android/app/google-services.json`
- Backend FCM: `GOOGLE_APPLICATION_CREDENTIALS` or `FCM_SERVICE_ACCOUNT_JSON`
- Production reset/invite email: implement the provider seam; local development can opt into `DEV_TOKEN_DELIVERY=true`
- Sentry: `SENTRY_DSN` and `VITE_SENTRY_DSN`
- SOS SMS fallback: Twilio environment variables and `SMS_SOS_ENABLED=true`
- Android release signing: `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, and `KEY_PASSWORD`
- Production Android API: `API_BASE_URL`

See [`backend/.env.example`](backend/.env.example) and [`dashboard/.env.example`](dashboard/.env.example) for the complete configuration surface.

## Further documentation

- [API contract](docs/api-contract.md)
- [Production deployment runbook](deploy/production/README.md)
- [CI/CD configuration](.github/README.md)

## Project status

The local product paths are complete and tested. Real push delivery, SMS delivery, signed Play releases, and production-cluster deployment require the corresponding external accounts and credentials; the repository provides the integration and deployment seams for them.
