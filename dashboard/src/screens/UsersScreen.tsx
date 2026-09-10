import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/api";
import type { Role } from "../api/api";

/** §7.2 item 6 — ADMIN user directory: search/filter, role changes and
 *  activate/deactivate (all audited server-side: USER_ROLE_CHANGED /
 *  USER_DEACTIVATED / USER_REACTIVATED). Inviting stays on the auth endpoint
 *  (§5.1); this screen manages EXISTING accounts. */
export function UsersScreen() {
  const queryClient = useQueryClient();
  const [roleFilter, setRoleFilter] = useState("");
  const [q, setQ] = useState("");
  const [driverName, setDriverName] = useState("");
  const [driverEmail, setDriverEmail] = useState("");
  const [driverPassword, setDriverPassword] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["users-admin", roleFilter, q],
    queryFn: () =>
      api.adminUsers({
        q: q || undefined,
        role: roleFilter || undefined,
        includeDeactivated: true,
        pageSize: 100,
      }),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["users-admin"] });

  const change = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number;
      body: Parameters<typeof api.updateAdminUser>[1];
    }) => api.updateAdminUser(id, body),
    onSuccess: invalidate,
  });

  const createDriver = useMutation({
    mutationFn: () =>
      api.createDriver({
        name: driverName.trim(),
        email: driverEmail.trim().toLowerCase(),
        password: driverPassword,
      }),
    onSuccess: () => {
      setDriverName("");
      setDriverEmail("");
      setDriverPassword("");
      invalidate();
    },
  });

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Users</h1>
        <div className="filters">
          <input
            placeholder="Search name / email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="user-search"
          />
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            aria-label="Filter by role"
          >
            <option value="">All roles</option>
            <option value="DRIVER">DRIVER</option>
            <option value="FLEET_MANAGER">FLEET_MANAGER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </div>
      </div>

      {isLoading && <p className="muted">Loading users…</p>}
      {error && <div className="banner-error">{(error as Error).message}</div>}

      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            driverName.trim() &&
            driverEmail.includes("@") &&
            driverPassword.length >= 8
          ) {
            createDriver.mutate();
          }
        }}
      >
        <input
          placeholder="Driver name (e.g. Kavya Reddy)"
          value={driverName}
          onChange={(event) => setDriverName(event.target.value)}
        />
        <input
          type="email"
          placeholder="Driver email"
          value={driverEmail}
          onChange={(event) => setDriverEmail(event.target.value)}
        />
        <input
          type="password"
          placeholder="Temporary password"
          value={driverPassword}
          minLength={8}
          onChange={(event) => setDriverPassword(event.target.value)}
        />
        <button type="submit" disabled={createDriver.isPending}>
          {createDriver.isPending ? "Adding…" : "Add driver"}
        </button>
      </form>
      {createDriver.error && (
        <div className="banner-error">{createDriver.error.message}</div>
      )}

      <div className="table-card">
        {data && data.items.length === 0 && (
          <p className="muted">No users match.</p>
        )}
        {data?.items.map((u) => (
          <div className="row" key={u.id} data-testid="user-row">
            <div className="row-main">
              <div className="row-title">
                <span
                  className={`badge ${u.status === "ACTIVE" ? "badge-ok" : "badge-open"}`}
                >
                  {u.status}
                </span>
                <strong>{u.name}</strong>
                <span className="muted small">{u.email}</span>
              </div>
              <div className="muted small">
                joined {new Date(u.createdAt).toLocaleDateString()} · {u.role}
              </div>
            </div>
            <div className="row-actions">
              <select
                value={u.role}
                aria-label="Role"
                onChange={(e) =>
                  change.mutate({
                    id: u.id,
                    body: { role: e.target.value as Role },
                  })
                }
              >
                <option value="DRIVER">DRIVER</option>
                <option value="FLEET_MANAGER">FLEET_MANAGER</option>
                <option value="ADMIN">ADMIN</option>
              </select>
              {u.role !== "ADMIN" || u.status === "DEACTIVATED" ? (
                <button
                  className={u.status === "ACTIVE" ? "danger" : ""}
                  disabled={change.isPending}
                  data-testid="toggle-status"
                  onClick={() =>
                    change.mutate({
                      id: u.id,
                      body: { deactivated: u.status !== "ACTIVE" },
                    })
                  }
                >
                  {u.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                </button>
              ) : (
                <span
                  className="muted small"
                  title="The last admin cannot be demoted or deactivated"
                >
                  protected
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
