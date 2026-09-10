import { describe, it, before } from "node:test";
import request from "supertest";
import { runExportJob } from "../src/services/exportService.js";
import { expect } from "./expectShim.js";
import {
  app,
  ADMIN_EMAIL,
  MANAGER_EMAIL,
  DRIVER_EMAIL,
  login,
  resetAndSeed,
  seedTripAndAlert,
  removeArtifact,
} from "./phase12-helper.js";

let adminToken;
let managerToken;

before(async () => {
  await resetAndSeed();
  adminToken = await login(ADMIN_EMAIL);
  managerToken = await login(MANAGER_EMAIL);
});

describe("Phase 12 - async CSV exports (SS7.2 item 3)", () => {
  it("enqueues a job (202 PENDING), the worker completes it, and the CSV downloads", async () => {
    await seedTripAndAlert();
    const create = await request(app)
      .post("/api/reports")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ type: "TRIPS_CSV" });
    expect(create.status).toBe(202);
    expect(create.body.job.status).toBe("PENDING");
    expect(create.body.job.type).toBe("TRIPS_CSV");
    const jobId = create.body.job.id;

    // Worker path (queues/worker.js calls exactly this for every exports job).
    const done = await runExportJob({ exportJobId: jobId });
    expect(done.status).toBe("DONE");
    expect(done.resultUrl).toBe(`/api/reports/${jobId}/download`);

    const dl = await request(app).get(`/api/reports/${jobId}/download`).set("Authorization", `Bearer ${adminToken}`);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toContain("text/csv");
    // Header row then one row per trip.
    const lines = dl.text.trim().split(/\r?\n/);
    expect(lines[0]).toContain("trip_id");
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // The alias mount from the blueprint: same contract at /api/trips/export.
    const alias = await request(app)
      .post("/api/trips/export")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ type: "ALERTS_CSV" });
    expect(alias.status).toBe(202);
    await runExportJob({ exportJobId: alias.body.job.id });
    const aliasDl = await request(app)
      .get(`/api/reports/${alias.body.job.id}/download`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(aliasDl.status).toBe(200);
    expect(aliasDl.text.split(/\r?\n/).length).toBeGreaterThanOrEqual(2);

    // Jobs are scoped per requester.
    const mine = await request(app).get("/api/reports").set("Authorization", `Bearer ${managerToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((j) => j.requestedBy !== undefined)).toBe(true);

    await removeArtifact(jobId);
    await removeArtifact(alias.body.job.id);
  });

  it("supports params and rejects invalid/forbidden requests", async () => {
    const bad = await request(app)
      .post("/api/reports")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ type: "PDF" });
    expect(bad.status).toBe(422);

    const filtered = await request(app)
      .post("/api/reports")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "TRIPS_CSV",
        params: { status: "COMPLETED", from: new Date().toISOString(), to: new Date().toISOString() },
      });
    expect(filtered.status).toBe(202);
    await runExportJob({ exportJobId: filtered.body.job.id });
    await removeArtifact(filtered.body.job.id);

    // A driver can't export (manager-only surface).
    const forbidden = await request(app)
      .post("/api/reports")
      .set("Authorization", `Bearer ${await login(DRIVER_EMAIL)}`)
      .send({ type: "TRIPS_CSV" });
    expect(forbidden.status).toBe(403);
  });
});
