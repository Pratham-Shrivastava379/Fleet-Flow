# Phase 15 — Production deployment (cloud-agnostic k8s)

Deployment assets for the **finished-product topology** (blueprint §13.3),
authored cloud-agnostic by decision: the manifests are plain Kubernetes that
run on EKS / GKE / AKS / k3s alike; the managed data-plane services (Postgres,
Redis, object storage) are referenced by connection string and must be
provisioned by whoever owns the real account. Nothing here can be exercised
end-to-end without a cluster + managed services — this directory is the seam
the Phase 14 CD pipeline plugs into.

## Topology (blueprint §13.3 → here)

| §13.3 component          | Here                                    |
| ------------------------ | --------------------------------------- |
| Managed Postgres+PostGIS | External `DATABASE_URL` (Secret)        |
| Managed Redis            | External `REDIS_URL` (Secret)           |
| API + WS gateway         | `k8s/api-deployment.yaml` (2+ pods, HPA, PDB) |
| Worker(s)                | `k8s/worker-deployment.yaml`            |
| Dashboard static hosting | `k8s/dashboard-deployment.yaml` (nginx image) |
| Secrets                  | k8s Secret (see below) — wire a cloud secrets manager via External Secrets Operator |
| Object storage (exports) | `k8s/storage.yaml` RWX PVC (interim) — migrate `exportService.deliver()` to S3/GCS presigned URLs |
| TLS/DNS                  | `k8s/ingress.yaml` (cert-manager + ingress controller) |
| Push (FCM)               | unchanged: `FCM_SERVICE_ACCOUNT_JSON` env when wired |

## Prerequisites

1. A cluster with an **ingress controller** (nginx) + **cert-manager** +
   **metrics-server** installed.
2. Managed **Postgres with PostGIS enabled** (RDS / Cloud SQL / Neon) and a
   managed **Redis** (ElastiCache / Memorystore) — reachable from the cluster.
3. The CD pipeline's images in GHCR (`ghcr.io/<repo>/fleetflow-{api,worker,
   migrate,dashboard}:<git-sha>` — cd.yml pushes all four).
4. DNS record pointing at the ingress (wildcard or `fleet.example.com`).

## Secrets

`k8s/secrets.example.yaml` is a **template with placeholder values**. Fill real
base64 values into `secrets.yaml` (never commit it) and apply:

```bash
cp k8s/secrets.example.yaml k8s/secrets.yaml   # edit: real values
kubectl apply -f k8s/secrets.yaml
```

Production path: use **External Secrets Operator** (or the cloud's secrets-manager
CSI driver) so values live in AWS Secrets Manager / GCP Secret Manager, never in
Git or plain k8s Secrets. `DATABASE_URL`/`REDIS_URL`/JWT secrets/metrics token
must all be non-dev values — `config.js` refuses to boot with `dev-` JWT
secrets under `NODE_ENV=production` (by design, §5.5).

## First deploy (cutover)

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secrets.yaml            # real values
kubectl apply -f k8s/storage.yaml

# 1. Schema migration FIRST (never `migrate dev`):
kubectl apply -f k8s/migrate-job.yaml
kubectl wait --for=condition=complete job/fleetflow-migrate -n fleetflow -t 300
kubectl logs job/fleetflow-migrate -n fleetflow   # confirm "No pending migrations"/applied

# 2. Workloads:
kubectl apply -f k8s/api-deployment.yaml k8s/api-service.yaml
kubectl apply -f k8s/worker-deployment.yaml
kubectl apply -f k8s/dashboard-deployment.yaml k8s/dashboard-service.yaml
kubectl apply -f k8s/hpa.yaml k8s/pdb.yaml
kubectl rollout status deployment/fleetflow-api -n fleetflow
kubectl rollout status deployment/fleetflow-worker -n fleetflow

# 3. Ingress + TLS:
kubectl apply -f k8s/ingress.yaml

# 4. One-time first ADMIN (never an HTTP endpoint; §5.2):
#    (scripts/ is baked into the image; refuses to run if an ADMIN exists)
kubectl exec -n fleetflow deploy/fleetflow-api -- node scripts/bootstrap-admin.js
```

## Smoke test (the §4.2 health contract)

```bash
curl -s https://fleet.example.com/api/health
# {"ok":true,"db":true,"redis":true,"ts":"…"}
curl -sI https://fleet.example.com/                     # dashboard 200
```

Then verify live: driver app start a trip → pings → manager logs into the
dashboard and watches the marker move on the **OpenStreetMap** live fleet map.

## Rollback

```bash
kubectl rollout undo deployment/fleetflow-api -n fleetflow
kubectl rollout undo deployment/fleetflow-worker -n fleetflow
kubectl rollout undo deployment/fleetflow-dashboard -n fleetflow
```

Database migrations are forward-only (`prisma migrate deploy`); a bad release
rolls back the image, not the schema.

## Phase 15 done-condition checklist (blueprint §15)

- [ ] Production topology stood up (this dir applied to a real cluster)
- [ ] Secrets in a secrets manager; nothing sensitive in Git or plain Secrets
- [ ] `bootstrap-admin.js` executed once; admin can log into the dashboard
- [ ] Test drive produces a visible live trip on the production dashboard
- [ ] Smoke test (`/api/health` + dashboard 200) passes against the production URL
- [ ] Load test re-run against staging at the real fleet-size target
      (`backend/scripts/load-test-pings.mjs`) — record p95 vs. the local baseline
      (≈150 ms @ 50 p/s, ≈265 ms @ 100 p/s on this dev laptop)
- [ ] Security review artifacts: prod-dep audits clean (backend + dashboard),
      CORS allow-list locked, Android release manifest forbids cleartext
      (verified this phase), repo history scanned for secrets

What this machine could not do (no accounts/cluster): provision the managed
services, apply the manifests, run the cutover, or cut the release — all
documented above as the remaining external steps.