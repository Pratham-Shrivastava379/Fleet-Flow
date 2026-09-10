import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/api";

/** §7.2 item 4 — fleet vehicle management: register, edit (model/status/
 *  default driver/maintenance note), soft-delete, all through the vehicle service
 *  (plate stays unique; deleted vehicles drop out of the default listing, §4.2). */
export function VehiclesScreen() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["vehicles"],
    queryFn: () => api.vehicles().then((r) => r.items),
  });
  const drivers = useQuery({
    queryKey: ["users-driver"],
    queryFn: () =>
      api.adminUsers({ role: "DRIVER", pageSize: 100 }).then((r) => r.items),
  });
  const queryClient = useQueryClient();

  const [plate, setPlate] = useState("");
  const [model, setModel] = useState("");

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["vehicles"] });

  const create = useMutation({
    mutationFn: () =>
      api.createVehicle({ plate: plate.trim(), model: model.trim() }),
    onSuccess: () => {
      setPlate("");
      setModel("");
      invalidate();
    },
  });

  const patch = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number;
      body: Parameters<typeof api.updateVehicle>[1];
    }) => api.updateVehicle(id, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteVehicle(id),
    onSuccess: invalidate,
  });

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Vehicles</h1>
      </div>

      {(isLoading || create.isPending) && <p className="muted">Loading…</p>}
      {error && <div className="banner-error">{(error as Error).message}</div>}

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (plate.trim() && model.trim()) create.mutate();
        }}
      >
        <input
          placeholder="Plate (e.g. KA-01-1234)"
          value={plate}
          onChange={(e) => setPlate(e.target.value)}
        />
        <input
          placeholder="Model (e.g. Tata Nexon)"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <button type="submit" disabled={create.isPending}>
          Add vehicle
        </button>
      </form>

      <div className="table-card">
        {data && data.length === 0 && <p className="muted">No vehicles yet.</p>}
        {data?.map((v) => (
          <div className="row" key={v.id} data-testid="vehicle-row">
            <div className="row-main">
              <div className="row-title">
                <span className="badge">{v.status}</span>
                <strong>{v.plate}</strong>
                <span className="muted small">{v.model}</span>
              </div>
              <div className="muted small">
                {v.deletedAt
                  ? `soft-deleted ${new Date(v.deletedAt).toLocaleDateString()}`
                  : "active"}
              </div>
            </div>
            <div className="row-actions">
              <select
                value={v.defaultDriverId ?? ""}
                onChange={(e) =>
                  patch.mutate({
                    id: v.id,
                    body: {
                      defaultDriverId:
                        e.target.value === "" ? null : Number(e.target.value),
                    },
                  })
                }
                aria-label="Default driver"
              >
                <option value="">No default driver</option>
                {(drivers.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.email})
                  </option>
                ))}
              </select>
              <select
                value={v.status}
                onChange={(e) =>
                  patch.mutate({
                    id: v.id,
                    body: { status: e.target.value as api.VehicleStatus },
                  })
                }
                aria-label="Status"
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="IN_MAINTENANCE">MAINTENANCE</option>
                <option value="RETIRED">RETIRED</option>
              </select>
              {!v.deletedAt && (
                <button className="danger" onClick={() => remove.mutate(v.id)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
