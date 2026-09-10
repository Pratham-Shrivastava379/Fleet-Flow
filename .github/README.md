# FleetFlow automation

FleetFlow uses GitHub Actions for continuous integration, scheduled end-to-end checks, Android instrumentation, container delivery, and Android releases.

## Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | Pull requests, pushes to `main`, manual | Backend tests with PostGIS and Redis, Android JVM tests/lint, dashboard tests/lint/build, dependency audit, and image scan |
| `e2e-nightly.yml` | Monday schedule, manual | Boots the containerized stack and runs the full web/API workflow including job queues |
| `android-instrumentation.yml` | Thursday schedule, manual | Runs `connectedDebugAndroidTest` on an Android emulator |
| `cd.yml` | Push to `main`, manual | Builds API, worker, migration, and dashboard images, publishes them to GHCR, then runs the gated staging deployment |
| `release-android.yml` | `v*` tag, manual | Builds release APK/AAB artifacts and uploads to Play internal testing when credentials exist |

## Repository configuration

Protect `main` and require these CI jobs before merge:

- `Backend (Postgres+Redis)`
- `Android (unit + lint)`
- `Dashboard (lint/type/test/build)`
- `Security (audit + Trivy)`

The staging deployment needs a self-hosted runner labeled `self-hosted, staging`.

## Secrets

| Secret | Workflow | Required for |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Android release | Signed APK/AAB |
| `ANDROID_KEYSTORE_PASSWORD` | Android release | Keystore access |
| `ANDROID_KEY_ALIAS` | Android release | Signing identity |
| `ANDROID_KEY_PASSWORD` | Android release | Signing key access |
| `ANDROID_VERSION_CODE` | Android release | Optional release version override |
| `RELEASE_API_BASE_URL` | Android release | Production API URL embedded in release builds |
| `SENTRY_DSN` | Android release | Optional Android error reporting |
| `PLAY_SERVICE_ACCOUNT_JSON` | Android release | Play internal-track upload |
| `STAGING_DATABASE_URL` | CD | Staging migration and deployment |
| `STAGING_DEPLOY_SECRET` | CD | Enables the protected staging job |
| `STAGING_URL` | CD | Post-deployment smoke test |

Jobs that depend on external accounts are skipped or remain inactive until their secrets are configured. No signing material, Firebase credentials, production connection strings, or service-account JSON belongs in the repository.
