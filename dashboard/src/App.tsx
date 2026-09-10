import { useState } from "react";
import { useAuth, RequireRole } from "./auth/AuthContext";
import { LoginScreen } from "./screens/LoginScreen";
import { LiveFleetScreen } from "./screens/LiveFleetScreen";
import { AlertsScreen } from "./screens/AlertsScreen";
import { TripsScreen } from "./screens/TripsScreen";
import { VehiclesScreen } from "./screens/VehiclesScreen";
import { GeofencesScreen } from "./screens/GeofencesScreen";
import { UsersScreen } from "./screens/UsersScreen";
import { AuditScreen } from "./screens/AuditScreen";

type Tab =
  "fleet" | "alerts" | "trips" | "vehicles" | "geofences" | "users" | "audit";

const TABS: { key: Tab; label: string; adminOnly?: boolean }[] = [
  { key: "fleet", label: "Fleet Map" },
  { key: "alerts", label: "Alerts" },
  { key: "trips", label: "Trips" },
  { key: "vehicles", label: "Vehicles" },
  { key: "geofences", label: "Geofences" },
  { key: "users", label: "Users", adminOnly: true },
  { key: "audit", label: "Audit Log", adminOnly: true },
];

export default function App() {
  const { user, ready, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("fleet");

  if (!ready) return <div className="auth-loading">Loading…</div>;
  if (!user) return <LoginScreen />;

  const isAdmin = user.role === "ADMIN";
  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin);
  // Fall back to fleet if the current tab is admin-only and the user isn't admin.
  const active: Tab =
    !isAdmin && (tab === "users" || tab === "audit") ? "fleet" : tab;

  const screen = {
    fleet: LiveFleetScreen,
    alerts: AlertsScreen,
    trips: TripsScreen,
    vehicles: VehiclesScreen,
    geofences: GeofencesScreen,
    users: UsersScreen,
    audit: AuditScreen,
  } as const;
  const ActiveScreen = screen[active];

  return (
    <RequireRole roles={["FLEET_MANAGER", "ADMIN"]}>
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">FleetFlow · Fleet Operations</div>
          <nav className="topnav" aria-label="Dashboard sections">
            {tabs.map((t) => (
              <button
                key={t.key}
                className={active === t.key ? "tab-active" : ""}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="topbar-right">
            <span className="muted small">
              {user.name} ({user.role})
            </span>
            <button onClick={() => void logout()}>Sign out</button>
          </div>
        </header>
        <main className="app-content">
          <ActiveScreen />
        </main>
      </div>
    </RequireRole>
  );
}
