package com.fleetflow.fleet

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import com.google.android.gms.maps.model.LatLng
import com.fleetflow.fleet.map.LiveTripMap
import com.fleetflow.fleet.tracking.TrackingService
import com.fleetflow.fleet.ui.theme.FleetFlowTheme

@Composable
fun TrackingScreen(
    vm: TrackingViewModel = hiltViewModel(),
    onOpenTrips: () -> Unit = {},
    onOpenAlerts: () -> Unit = {},
    onOpenProfile: () -> Unit = {},
) {
    val context = LocalContext.current
    val state = vm.state

    // ACTIVE-TRIP RECOVERY: reconcile the persisted/remote active trip on every
    // screen entry (covers app restart, process death, reinstall-with-backend-
    // active-trip). Runs before loadVehicles so the correct panel shows.
    LaunchedEffect(Unit) {
        vm.recoverActiveTrip()
        vm.loadVehicles()
    }

    // Runtime permission flow incl. denied/revoked states (API 33+ notifications too)
    val permissions = remember {
        mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        ).apply { if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS) }
            .toTypedArray()
    }
    var hasPermission by remember { mutableStateOf(false) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        hasPermission = it.values.all { granted -> granted }
        if (hasPermission) vm.state.activeTripId?.let { tripId -> TrackingService.start(context, tripId) }
    }

    LaunchedEffect(Unit) {
        hasPermission = permissions.all {
            ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    FleetFlowTheme {
        Scaffold { padding ->
            Column(
                Modifier.padding(padding).padding(16.dp).fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // Phase 9: nav row to the driver screens (§3.1 role-gated graph).
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onOpenTrips) { Text("Trips") }
                    Button(onClick = onOpenAlerts) { Text("Alerts") }
                    Button(onClick = onOpenProfile) { Text("Profile") }
                }
                if (state.error != null) Card { Text("⚠ ${state.error}", Modifier.padding(12.dp)) }

                when {
                    state.loading -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))

                    state.activeTripId == null -> VehicleList(state, hasPermission) { vehicle ->
                        if (hasPermission) {
                            vm.startTrip(vehicle.id) { tripId -> TrackingService.start(context, tripId) }
                        } else {
                            permissionLauncher.launch(permissions)
                        }
                    }

                    else -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        // Live map surface: recorded route polyline + gesture-driven
                        // follow toggle. Fix collection lives in TrackingViewModel
                        // (single collector — a second one here would double-append
                        // every fix to the route and re-append the replayed last fix
                        // each time this effect restarts on recomposition).
                        LiveTripMap(
                            current = state.lastLat?.let { lat ->
                                state.lastLng?.let { lng -> LatLng(lat, lng) }
                            },
                            route = state.route,
                            follow = state.follow,
                            onFollowChange = vm::setFollow,
                        )
                        ActiveTripPanel(
                            tripId = state.activeTripId,
                            pendingFinish = state.pendingFinish,
                            onStartSync = vm::syncNow,
                            onSos = vm::sos,
                            onFinish = { TrackingService.stop(context); vm.finishTrip() },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun VehicleList(state: TrackingState, hasPermission: Boolean, onStart: (com.fleetflow.fleet.data.VehicleDto) -> Unit) {
    Text("Select a vehicle to start a trip", style = MaterialTheme.typography.titleMedium)
    if (state.vehicles.isEmpty()) {
        Text("No vehicles yet. Seed one via the API (see README).")
    }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(state.vehicles) { vehicle ->
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(vehicle.plate, style = MaterialTheme.typography.titleMedium)
                        Text(vehicle.model, style = MaterialTheme.typography.bodySmall)
                    }
                    Button(onClick = { onStart(vehicle) }) { Text("Start") }
                }
            }
        }
    }
}

@Composable
private fun ActiveTripPanel(
    tripId: Int?,
    pendingFinish: Boolean,
    onStartSync: () -> Unit,
    onSos: () -> Unit,
    onFinish: () -> Unit,
) {
    Text("Trip #$tripId active", style = MaterialTheme.typography.titleLarge)
    if (pendingFinish) {
        Text(
            "Finish requested — waiting for network to upload remaining location data. " +
                "The trip completes automatically once the queue drains.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.tertiary,
        )
    }
    Text(
        "Location is recorded offline-first; pings sync automatically when online.",
        style = MaterialTheme.typography.bodySmall,
    )
    Button(onClick = onStartSync, modifier = Modifier.fillMaxWidth()) { Text("Sync now") }
    Button(
        onClick = onSos,
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
        modifier = Modifier.fillMaxWidth(),
    ) { Text("SOS") }
    if (!pendingFinish) {
        OutlinedButton(onClick = onFinish, modifier = Modifier.fillMaxWidth()) { Text("Finish trip") }
    }
}
