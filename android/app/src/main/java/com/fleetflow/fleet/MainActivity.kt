package com.fleetflow.fleet

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.fleetflow.fleet.screens.AlertsScreen
import com.fleetflow.fleet.screens.AuditLogScreen
import com.fleetflow.fleet.screens.FleetMapScreen
import com.fleetflow.fleet.screens.FleetOperationsScreen
import com.fleetflow.fleet.screens.GeofencesScreen
import com.fleetflow.fleet.screens.ProfileScreen
import com.fleetflow.fleet.screens.TeamScreen
import com.fleetflow.fleet.screens.TripDetailScreen
import com.fleetflow.fleet.screens.TripsScreen
import com.fleetflow.fleet.screens.VehiclesScreen
import com.fleetflow.fleet.ui.theme.FleetFlowTheme
import dagger.hilt.android.AndroidEntryPoint

/** Role-gated application navigation for driver, fleet-manager and admin flows. */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            FleetFlowTheme { FleetNavHost() }
        }
    }
}

@Composable
fun FleetNavHost() {
    val nav = rememberNavController()
    NavHost(navController = nav, startDestination = "login") {
        composable("login") {
            LoginScreen(onAuthed = { isDriver ->
                // Role-gated landing: drivers go to
                // the tracking flow; manager/admin go to the read-oriented fleet
                // view. The backend still rejects any manager/admin trip-start.
                nav.navigate(if (isDriver) "tracking" else "fleet") { popUpTo("login") { inclusive = true } }
            })
        }
        // Driver home: live tracking flow.
        composable("tracking") {
            TrackingScreen(
                onOpenTrips = { nav.navigate("trips") },
                onOpenAlerts = { nav.navigate("alerts") },
                onOpenProfile = { nav.navigate("profile") },
            )
        }
        // Manager/admin home: fleet view (trip history across the fleet). Not a
        // driver flow — no start-trip/SOS entry points are reachable from here.
        composable("fleet") {
            FleetOperationsScreen(
                onOpenMap = { nav.navigate("fleet-map") },
                onOpenAlerts = { nav.navigate("fleet-alerts") },
                onOpenTrips = { nav.navigate("fleet-trips") },
                onOpenVehicles = { nav.navigate("vehicles") },
                onOpenGeofences = { nav.navigate("geofences") },
                onOpenUsers = { nav.navigate("team") },
                onOpenAudit = { nav.navigate("audit") },
                onOpenProfile = { nav.navigate("profile") },
                onLoggedOut = { nav.navigate("login") { popUpTo(0) { inclusive = true } } },
            )
        }
        composable("fleet-map") { FleetMapScreen(onBack = { nav.popBackStack() }) }
        composable("fleet-alerts") { AlertsScreen(onBack = { nav.popBackStack() }) }
        composable("fleet-trips") {
            TripsScreen(
                onOpenTrip = { nav.navigate("trip-detail/$it") },
                onBack = { nav.popBackStack() },
            )
        }
        composable("vehicles") { VehiclesScreen(onBack = { nav.popBackStack() }) }
        composable("geofences") { GeofencesScreen(onBack = { nav.popBackStack() }) }
        composable("team") { TeamScreen(onBack = { nav.popBackStack() }) }
        composable("audit") { AuditLogScreen(onBack = { nav.popBackStack() }) }
        composable("trips") { TripsScreen(onOpenTrip = { nav.navigate("trip-detail/$it") }) }
        composable("trip-detail/{tripId}") { entry ->
            val tripId = entry.arguments?.getString("tripId")?.toIntOrNull() ?: 0
            TripDetailScreen(tripId = tripId, onBack = { nav.popBackStack() })
        }
        composable("alerts") { AlertsScreen() }
        composable("profile") {
            ProfileScreen(onLoggedOut = {
                nav.navigate("login") { popUpTo(0) { inclusive = true } }
            })
        }
    }
}
