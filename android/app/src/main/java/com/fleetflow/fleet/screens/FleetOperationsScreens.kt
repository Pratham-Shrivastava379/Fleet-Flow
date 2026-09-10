package com.fleetflow.fleet.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.fleetflow.fleet.BuildConfig
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.LatLng
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.Marker
import com.google.maps.android.compose.MarkerState
import com.google.maps.android.compose.rememberCameraPositionState

@Composable
fun FleetOperationsScreen(
    vm: FleetOperationsViewModel = hiltViewModel(),
    logoutVm: ProfileViewModel = hiltViewModel(),
    onOpenMap: () -> Unit,
    onOpenAlerts: () -> Unit,
    onOpenTrips: () -> Unit,
    onOpenVehicles: () -> Unit,
    onOpenGeofences: () -> Unit,
    onOpenUsers: () -> Unit,
    onOpenAudit: () -> Unit,
    onOpenProfile: () -> Unit,
    onLoggedOut: () -> Unit,
) {
    LaunchedEffect(Unit) { vm.load() }
    ScreenScaffold("Fleet Operations") { modifier ->
        Column(
            modifier.verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Welcome, ${vm.user?.name ?: "fleet operator"}",
                style = MaterialTheme.typography.headlineSmall,
            )
            AssistChip(onClick = {}, label = { Text(vm.role.replace('_', ' ')) })
            vm.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (vm.loading) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SummaryCard("Active", vm.activeTrips.size.toString(), Modifier.weight(1f))
                SummaryCard("Open alerts", vm.alerts.count { it.status == "OPEN" }.toString(), Modifier.weight(1f))
                SummaryCard("Vehicles", vm.vehicles.size.toString(), Modifier.weight(1f))
            }

            Text("Operations", style = MaterialTheme.typography.titleLarge)
            OperationButton("Live fleet map", "Track active drivers and their latest positions", onOpenMap)
            OperationButton("Alert inbox", "Acknowledge and resolve safety events", onOpenAlerts)
            OperationButton("Trip history", "Review fleet trips, statistics and route replay", onOpenTrips)
            OperationButton("Vehicles", "View fleet status, assignments and maintenance notes", onOpenVehicles)
            OperationButton("Geofences", "Review active operating zones and alert rules", onOpenGeofences)
            OperationButton("Team directory", "View drivers, managers and administrators", onOpenUsers)
            if (vm.isAdmin) {
                Text("Administration", style = MaterialTheme.typography.titleLarge)
                OperationButton("Audit log", "Review security-sensitive administrative activity", onOpenAudit)
            }
            OperationButton("Profile & notifications", "Account, permissions and push preferences", onOpenProfile)
            OutlinedButton(
                onClick = { logoutVm.logout(onLoggedOut) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Log out") }
        }
    }
}

@Composable
private fun SummaryCard(label: String, value: String, modifier: Modifier = Modifier) {
    Card(modifier) {
        Column(Modifier.padding(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(value, style = MaterialTheme.typography.headlineSmall)
            Text(label, style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun OperationButton(title: String, subtitle: String, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
fun FleetMapScreen(vm: FleetOperationsViewModel = hiltViewModel(), onBack: () -> Unit) {
    LaunchedEffect(Unit) { vm.load() }
    ScreenScaffold("Live Fleet", onBack) { modifier ->
        Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            vm.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (vm.loading) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            val positioned = vm.activeTrips.mapNotNull { trip ->
                trip.vehicle?.fleetLastPosition?.let { trip to it }
            }
            if (BuildConfig.GOOGLE_MAPS_KEY.isNotBlank()) {
                val first = positioned.firstOrNull()?.second
                val camera = rememberCameraPositionState {
                    position = CameraPosition.fromLatLngZoom(
                        first?.let { LatLng(it.lat, it.lng) } ?: LatLng(12.9716, 77.5946),
                        12f,
                    )
                }
                GoogleMap(Modifier.fillMaxWidth().height(360.dp), cameraPositionState = camera) {
                    positioned.forEach { (trip, pos) ->
                        Marker(
                            state = MarkerState(LatLng(pos.lat, pos.lng)),
                            title = trip.vehicle?.plate ?: "Vehicle",
                            snippet = "${trip.driver?.name ?: "Driver"} · ${"%.1f".format(pos.speedKmh)} km/h",
                        )
                    }
                }
            }
            if (!vm.loading && vm.activeTrips.isEmpty()) {
                Text("No active trips right now.", textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            } else {
                Text("${vm.activeTrips.size} active trip(s) · ${positioned.size} reporting location")
                vm.activeTrips.forEach { trip ->
                    val p = trip.vehicle?.fleetLastPosition
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(10.dp)) {
                            Text(trip.vehicle?.plate ?: "Unassigned", style = MaterialTheme.typography.titleMedium)
                            Text(trip.driver?.name ?: "Unknown driver")
                            Text(p?.let { "%.5f, %.5f · %.1f km/h".format(it.lat, it.lng, it.speedKmh) } ?: "Waiting for location")
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun VehiclesScreen(vm: FleetOperationsViewModel = hiltViewModel(), onBack: () -> Unit) {
    LaunchedEffect(Unit) { vm.load() }
    var showAdd by remember { mutableStateOf(false) }
    var plate by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    val drivers = vm.users.filter { it.role == "DRIVER" && it.status == "ACTIVE" }

    ScreenScaffold("Vehicles", onBack) { modifier ->
        LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Button(onClick = { showAdd = !showAdd }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (showAdd) "Cancel" else "Add vehicle")
                }
            }
            vm.actionMessage?.let { message -> item { ActionMessage(message) } }
            vm.error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
            if (showAdd) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Register vehicle", style = MaterialTheme.typography.titleMedium)
                            OutlinedTextField(
                                value = plate,
                                onValueChange = { plate = it.uppercase() },
                                label = { Text("Registration number") },
                                placeholder = { Text("KA-01-AB-1234") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            OutlinedTextField(
                                value = model,
                                onValueChange = { model = it },
                                label = { Text("Vehicle model") },
                                placeholder = { Text("Tata Ace Gold") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Button(
                                onClick = { vm.addVehicle(plate, model) { plate = ""; model = ""; showAdd = false } },
                                enabled = !vm.actionBusy && plate.trim().length >= 3 && model.isNotBlank(),
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text(if (vm.actionBusy) "Adding…" else "Add to fleet") }
                        }
                    }
                }
            }
            if (!vm.loading && vm.vehicles.isEmpty() && vm.error == null) item { Text("No vehicles yet.") }
        items(vm.vehicles, key = { it.id }) { vehicle ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(vehicle.plate, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                        Text(vehicle.status.replace('_', ' '), color = MaterialTheme.colorScheme.primary)
                    }
                    Text(vehicle.model)
                    CompactDropdown(
                        label = "Status",
                        value = vehicle.status.replace('_', ' '),
                        options = listOf(
                            "ACTIVE" to "Active",
                            "IN_MAINTENANCE" to "In maintenance",
                            "RETIRED" to "Retired",
                        ),
                        enabled = !vm.actionBusy,
                    ) { vm.setVehicleStatus(vehicle.id, it) }
                    CompactDropdown(
                        label = "Default driver",
                        value = drivers.firstOrNull { it.id == vehicle.defaultDriverId }?.name ?: "Unassigned",
                        options = listOf("" to "Unassigned") + drivers.map { it.id.toString() to it.name },
                        enabled = !vm.actionBusy,
                    ) { vm.assignVehicle(vehicle.id, it.toIntOrNull()) }
                    vehicle.maintenanceNote?.takeIf { it.isNotBlank() }?.let { Text("Maintenance: $it") }
                }
            }
        }
            if (vm.loading) item { CircularProgressIndicator(Modifier.padding(16.dp)) }
        }
    }
}

@Composable
fun GeofencesScreen(vm: FleetOperationsViewModel = hiltViewModel(), onBack: () -> Unit) {
    LaunchedEffect(Unit) { vm.load() }
    var showAdd by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var latitude by remember { mutableStateOf("12.9716") }
    var longitude by remember { mutableStateOf("77.5946") }
    var radius by remember { mutableStateOf("500") }
    var alertOnEnter by remember { mutableStateOf(true) }
    var alertOnExit by remember { mutableStateOf(true) }
    val lat = latitude.toDoubleOrNull()
    val lng = longitude.toDoubleOrNull()
    val radiusM = radius.toDoubleOrNull()

    ScreenScaffold("Geofences", onBack) { modifier ->
        LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Button(onClick = { showAdd = !showAdd }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (showAdd) "Cancel" else "Create geofence")
                }
            }
            vm.actionMessage?.let { message -> item { ActionMessage(message) } }
            vm.error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
            if (showAdd) item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("New operating zone", style = MaterialTheme.typography.titleMedium)
                        OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(
                            latitude,
                            { latitude = it },
                            label = { Text("Latitude") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            longitude,
                            { longitude = it },
                            label = { Text("Longitude") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            radius,
                            { radius = it },
                            label = { Text("Radius (metres)") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        ToggleRow("Alert on entry", alertOnEnter) { alertOnEnter = it }
                        ToggleRow("Alert on exit", alertOnExit) { alertOnExit = it }
                        Button(
                            onClick = {
                                vm.addGeofence(name, lat!!, lng!!, radiusM!!, alertOnEnter, alertOnExit) {
                                    name = ""; showAdd = false
                                }
                            },
                            enabled = !vm.actionBusy && name.isNotBlank() && lat != null && lat in -90.0..90.0 &&
                                lng != null && lng in -180.0..180.0 && radiusM != null && radiusM >= 10.0,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(if (vm.actionBusy) "Creating…" else "Create zone") }
                    }
                }
            }
        items(vm.geofences, key = { it.id }) { fence ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(fence.name, style = MaterialTheme.typography.titleMedium)
                    Text("%.5f, %.5f · %.0f m radius".format(fence.centerLat, fence.centerLng, fence.radiusM))
                    Text(
                        listOfNotNull(
                            "Enter alerts".takeIf { fence.alertOnEnter },
                            "Exit alerts".takeIf { fence.alertOnExit },
                        ).joinToString(" · ").ifBlank { "Alerts disabled" },
                        style = MaterialTheme.typography.bodySmall,
                    )
                    ToggleRow("Active", fence.active) { vm.setGeofenceActive(fence.id, it) }
                }
            }
        }
            if (vm.loading) item { CircularProgressIndicator(Modifier.padding(16.dp)) }
        }
    }
}

@Composable
fun TeamScreen(vm: FleetOperationsViewModel = hiltViewModel(), onBack: () -> Unit) {
    LaunchedEffect(Unit) { vm.load() }
    var showAdd by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    ScreenScaffold("Team Directory", onBack) { modifier ->
        LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (vm.isAdmin) item {
                Button(onClick = { showAdd = !showAdd }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (showAdd) "Cancel" else "Add driver")
                }
            }
            vm.actionMessage?.let { message -> item { ActionMessage(message) } }
            vm.error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
            if (vm.isAdmin && showAdd) item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Create driver account", style = MaterialTheme.typography.titleMedium)
                        OutlinedTextField(name, { name = it }, label = { Text("Full name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(
                            password,
                            { password = it },
                            label = { Text("Temporary password") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text("The driver can sign in immediately with this temporary password.", style = MaterialTheme.typography.bodySmall)
                        Button(
                            onClick = {
                                vm.addDriver(email, name, password) {
                                    name = ""; email = ""; password = ""; showAdd = false
                                }
                            },
                            enabled = !vm.actionBusy && name.isNotBlank() && email.contains('@') && password.length >= 8,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(if (vm.actionBusy) "Adding…" else "Create driver") }
                    }
                }
            }
        items(vm.users, key = { it.id }) { user ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(user.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                        AssistChip(onClick = {}, label = { Text(user.status) })
                    }
                    Text(user.email)
                    Text(user.role.replace('_', ' '), style = MaterialTheme.typography.bodySmall)
                    if (vm.isAdmin && user.role == "DRIVER") {
                        OutlinedButton(
                            onClick = { vm.setUserDeactivated(user.id, user.status == "ACTIVE") },
                            enabled = !vm.actionBusy,
                        ) { Text(if (user.status == "ACTIVE") "Deactivate" else "Reactivate") }
                    }
                }
            }
        }
            if (vm.loading) item { CircularProgressIndicator(Modifier.padding(16.dp)) }
        }
    }
}

@Composable
private fun ActionMessage(message: String) {
    Card(Modifier.fillMaxWidth()) {
        Text(message, Modifier.padding(10.dp), color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun CompactDropdown(
    label: String,
    value: String,
    options: List<Pair<String, String>>,
    enabled: Boolean,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { expanded = true }, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
            Text("$label: $value")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (key, text) ->
                DropdownMenuItem(
                    text = { Text(text) },
                    onClick = { expanded = false; onSelect(key) },
                )
            }
        }
    }
}

@Composable
fun AuditLogScreen(vm: FleetOperationsViewModel = hiltViewModel(), onBack: () -> Unit) {
    LaunchedEffect(Unit) { vm.load() }
    SimpleListScaffold("Audit Log", onBack, vm.loading, vm.error, vm.auditLogs.isEmpty()) {
        items(vm.auditLogs, key = { it.id }) { entry ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(entry.action.replace('_', ' '), style = MaterialTheme.typography.titleMedium)
                    Text(entry.target)
                    if (entry.detail.isNotBlank()) Text(entry.detail, style = MaterialTheme.typography.bodySmall)
                    Text("${entry.actor?.email ?: "System"} · ${entry.createdAt}", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
private fun SimpleListScaffold(
    title: String,
    onBack: () -> Unit,
    loading: Boolean,
    error: String?,
    empty: Boolean,
    rows: androidx.compose.foundation.lazy.LazyListScope.() -> Unit,
) {
    ScreenScaffold(title, onBack) { modifier ->
        Box(modifier) {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (error != null) item { Text(error, color = MaterialTheme.colorScheme.error) }
                if (!loading && empty && error == null) item { Text("Nothing to show yet.") }
                rows()
            }
            if (loading) CircularProgressIndicator(Modifier.align(Alignment.Center))
        }
    }
}
