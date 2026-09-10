import { describe, it, before } from "node:test";
import request from "supertest";
import { prisma } from "../src/prisma.js";
import { expect } from "./expectShim.js";
import { app, PASS, ADMIN_EMAIL, MANAGER_EMAIL, DRIVER_EMAIL, login, resetAndSeed } from "./phase12-helper.js";

let adminToken;
let managerToken;

before(async () => {
  await resetAndSeed();
  adminToken = await login(ADMIN_EMAIL);
  managerToken = await login(MANAGER_EMAIL);
});

describe("Phase 12 - fleet user administration (SS7.2 item 4)", () => {
  it("lets an admin provision a driver account but rejects manager provisioning", async () => {
    const body = {
      email: "mobile.driver@fleetflow.test",
      name: "Kavya Reddy",
      password: "Newdriver1",
    };
    const denied = await request(app)
      .post("/api/users-admin")
      .set("Authorization", `Bearer ${managerToken}`)
      .send(body);
    expect(denied.status).toBe(403);

    const created = await request(app).post("/api/users-admin").set("Authorization", `Bearer ${adminToken}`).send(body);
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("Kavya Reddy");
    expect(created.body.role).toBe("DRIVER");
    expect(created.body.status).toBe("ACTIVE");

    const driverLogin = await request(app).post("/api/auth/login").send({ email: body.email, password: body.password });
    expect(driverLogin.status).toBe(200);

    const audit = await request(app)
      .get("/api/audit-logs?action=USER_CREATED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(audit.body.items.some((entry) => entry.target === `user:${created.body.id}`)).toBe(true);
  });

  it("deactivates a driver, revokes sessions, blocks login + refresh, reactivates", async () => {
    const list = await request(app).get("/api/users-admin").set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    const driver = list.body.items.find((u) => u.email === DRIVER_EMAIL);
    expect(driver).toBeTruthy();
    expect(driver.status).toBe("ACTIVE");

    // Fresh web session for the driver — deactivation must kill it.
    const driverLogin = await request(app)
      .post("/api/auth/login")
      .set("X-Client", "web")
      .send({ email: DRIVER_EMAIL, password: PASS });
    expect(driverLogin.status).toBe(200);
    const cookie = (driverLogin.headers["set-cookie"] || []).find((c) => c.startsWith("fleetflow_refresh="));
    expect(cookie).toBeTruthy();

    const deact = await request(app)
      .patch(`/api/users-admin/${driver.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ deactivated: true });
    expect(deact.status).toBe(200);
    expect(deact.body.status).toBe("DEACTIVATED");

    // Login now refuses (indistinguishable from bad credentials).
    const blocked = await request(app)
      .post("/api/auth/login")
      .set("X-Client", "web")
      .send({ email: DRIVER_EMAIL, password: PASS });
    expect(blocked.status).toBe(401);

    // The pre-deactivation refresh token no longer mints access tokens...
    if (cookie) {
      const value = cookie.split(";")[0].split("=")[1];
      const refreshed = await request(app)
        .post("/api/auth/refresh")
        .set("X-Client", "web")
        .set("Cookie", `vxd_rt=${value}`)
        .send({});
      expect(refreshed.status).toBe(401);
    }

    // ...and the directory's ACTIVE filter excludes them (includeDeactivated to see it).
    const activeOnly = await request(app).get("/api/users-admin").set("Authorization", `Bearer ${adminToken}`);
    expect(activeOnly.body.items.some((u) => u.email === DRIVER_EMAIL)).toBe(false);
    const withDeactivated = await request(app)
      .get("/api/users-admin?includeDeactivated=true&status=DEACTIVATED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(withDeactivated.body.items.some((u) => u.email === DRIVER_EMAIL)).toBe(true);

    // Reactivation restores the SAME account (role preserved).
    const react = await request(app)
      .patch(`/api/users-admin/${driver.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ deactivated: false });
    expect(react.status).toBe(200);
    expect(react.body.status).toBe("ACTIVE");
    const relogin = await request(app)
      .post("/api/auth/login")
      .set("X-Client", "web")
      .send({ email: DRIVER_EMAIL, password: PASS });
    expect(relogin.status).toBe(200);

    // Role change is audited with before/after detail.
    const roleChange = await request(app)
      .patch(`/api/users-admin/${driver.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "FLEET_MANAGER" });
    expect(roleChange.status).toBe(200);
    expect(roleChange.body.role).toBe("FLEET_MANAGER");
    const audit = await request(app)
      .get("/api/audit-logs?action=USER_ROLE_CHANGED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(audit.status).toBe(200);
    const entry = audit.body.items.find((e) => e.target === `user:${driver.id}`);
    expect(entry).toBeTruthy();
    expect(entry.detail).toContain("DRIVER -> FLEET_MANAGER");
    // Put it back so later tests see the original driver.
    await prisma.user.update({ where: { id: driver.id }, data: { role: "DRIVER" } });
  });

  it("protects the last admin from demotion and deactivation (409)", async () => {
    const me = await request(app).get("/api/users-admin").set("Authorization", `Bearer ${adminToken}`);
    const adminRow = me.body.items.find((u) => u.role === "ADMIN");
    expect(adminRow).toBeTruthy();

    const demote = await request(app)
      .patch(`/api/users-admin/${adminRow.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "FLEET_MANAGER" });
    expect(demote.status).toBe(409);
    expect(String(demote.body.error)).toContain("last admin");

    const deactivate = await request(app)
      .patch(`/api/users-admin/${adminRow.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ deactivated: true });
    expect(deactivate.status).toBe(409);
  });

  it("lets managers read the directory but not mutate it", async () => {
    const list = await request(app).get("/api/users-admin").set("Authorization", `Bearer ${managerToken}`);
    expect(list.status).toBe(200);
    const target = list.body.items.find((u) => u.email === DRIVER_EMAIL);
    const patch = await request(app)
      .patch(`/api/users-admin/${target.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ name: "Nope" });
    expect(patch.status).toBe(403);
  });
});
