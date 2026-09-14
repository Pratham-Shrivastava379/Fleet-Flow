package com.fleetflow.fleet.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.mutableIntStateOf
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.hilt.navigation.compose.hiltViewModel
import com.fleetflow.fleet.BuildConfig
import com.fleetflow.fleet.data.AlertDto
import com.fleetflow.fleet.data.NotificationPrefs
import com.fleetflow.fleet.data.PingDto
import com.fleetflow.fleet.data.TripListItemDto
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.model.BitmapDescriptorFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.MapUiSettings
import com.google.maps.android.compose.Marker
import com.google.maps.android.compose.MarkerState
import com.google.maps.android.compose.Polyline
import com.google.maps.android.compose.rememberCameraPositionState
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

private val TIME_FMT = DateTimeFormatter.ofPattern("MMM d, HH:mm").withZone(ZoneId.systemDefault())

private fun fmt(iso: String?): String =
    iso?.let { runCatching { TIME_FMT.format(Instant.parse(it)) }.getOrDefault(it) } ?: "—"

/** Shared Chrome: title + optional back. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenScaffold(title: String, onBack: (() -> Unit)? = null, content: (@Composable (Modifier) -> Unit)) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                    }
                },
            )
        },
    ) { padding -> content(Modifier.padding(padding).padding(16.dp).fillMaxSize()) }
}

@Composable
private fun ErrorRetry(error: String?, onRetry: () -> Unit) {
    if (error != null) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("⚠ $error")
                Button(onClick = onRetry) { Text("Retry") }
            }
        }
    }
}

// ---------------- Trip History ----------------

@Composable
fun TripsScreen(
    vm: TripsViewModel = hiltViewModel(),
    onOpenTrip: (Int) -> Unit,
    onBack: (() -> Unit)? = null,
) {
    LaunchedEffect(Unit) { vm.load() }
    ScreenScaffold("Trip History", onBack) { modifier ->
        Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ErrorRetry(vm.error) { vm.load() }
            if (vm.loading) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            if (!vm.loading && vm.trips.isEmpty() && vm.error == null) {
                Text("No trips yet. Start one from Tracking.", textAlign = TextAlign.Center)
            }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(vm.trips, key = { it.id }) { trip -> TripRow(trip, onOpenTrip) }
            }
        }
    }
}

@Composable
private fun TripRow(trip: TripListItemDto, onOpen: (Int) -> Unit) {
    val pingCount = trip.count?.pings ?: 0
    Card(onClick = { onOpen(trip.id) }, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    trip.vehicle?.plate ?: "No vehicle",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    trip.status,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            Text(
                "${fmt(trip.startedAt)} → ${fmt(trip.finishedAt)}",
                style = MaterialTheme.typography.bodySmall,
            )
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "$pingCount GPS ${if (pingCount == 1) "point" else "points"}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    "View replay →",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}

// ---------------- Trip Detail + map replay ----------------

@Composable
fun TripDetailScreen(tripId: Int, vm: TripDetailViewModel = hiltViewModel(), onBack: () -> Unit) {
    LaunchedEffect(tripId) { vm.load(tripId) }
    val trip = vm.trip
    ScreenScaffold("Trip #$tripId", onBack) { modifier ->
        Column(
            modifier.verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (vm.loading) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            else if (trip == null) {
                ErrorRetry(vm.error ?: "Trip not found") { vm.load(tripId) }
            } else {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("${trip.vehicle?.plate ?: "—"} · ${trip.status}", style = MaterialTheme.typography.titleMedium)
                        Text("${fmt(trip.startedAt)} → ${fmt(trip.finishedAt)}", style = MaterialTheme.typography.bodySmall)
                        Text(
                            "Distance: ${trip.distanceKm ?: vm.stats?.distanceKm ?: "—"} km · Avg: ${trip.avgSpeedKmh ?: vm.stats?.avgSpeedKmh ?: "—"} km/h · Max: ${trip.maxSpeedKmh ?: vm.stats?.maxSpeedKmh ?: "—"} km/h",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
                ReplayMap(trip.pings, Modifier.fillMaxWidth())
            }
        }
    }
}

/**
 * Offline-safe map replay (Phase 9 §3.5): draws the ordered ping polyline on a
 * Canvas normalized to the trip's bounding box, with a scrubber marker.
 * Google Maps tiles (maps-compose) remain an explicit open gap until a real
 * API key is provided — this renders the actual replay path with NO key.
 */
@Composable
fun ReplayMap(pings: List<PingDto>, modifier: Modifier = Modifier) {
    val orderedPings = remember(pings) { pings.sortedBy { it.recordedAt } }
    var currentIndex by remember(orderedPings) { mutableIntStateOf(orderedPings.lastIndex.coerceAtLeast(0)) }
    var isPlaying by remember(orderedPings) { mutableStateOf(false) }

    LaunchedEffect(isPlaying, orderedPings) {
        while (isPlaying && currentIndex < orderedPings.lastIndex) {
            delay(700)
            currentIndex++
        }
        if (currentIndex >= orderedPings.lastIndex) isPlaying = false
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Route replay", style = MaterialTheme.typography.titleMedium)
        Text(
            "Watch the recorded journey unfold point by point.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (orderedPings.isEmpty()) {
            Card(Modifier.fillMaxWidth()) { Text("No pings recorded for this trip.", Modifier.padding(12.dp)) }
        } else {
            val shown = orderedPings.take(currentIndex + 1)
            val selected = orderedPings[currentIndex]
            if (BuildConfig.GOOGLE_MAPS_KEY.isNotBlank()) {
                GoogleReplayMap(orderedPings, shown)
            } else {
                OfflineReplayMap(orderedPings, shown)
            }

            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(fmt(selected.recordedAt), style = MaterialTheme.typography.labelLarge)
                Text(
                    "%.1f km/h".format(selected.speedKmh),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.primary,
                    textAlign = TextAlign.End,
                    modifier = Modifier.weight(1f),
                )
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = {
                        if (currentIndex == orderedPings.lastIndex) currentIndex = 0
                        isPlaying = !isPlaying
                    },
                ) {
                    Text(if (isPlaying) "Pause" else if (currentIndex == orderedPings.lastIndex) "Replay" else "Resume")
                }
                Slider(
                    value = currentIndex.toFloat(),
                    onValueChange = {
                        isPlaying = false
                        currentIndex = it.roundToInt().coerceIn(0, orderedPings.lastIndex)
                    },
                    valueRange = 0f..orderedPings.lastIndex.coerceAtLeast(1).toFloat(),
                    steps = (orderedPings.size - 2).coerceAtLeast(0),
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                )
                Text("${currentIndex + 1}/${orderedPings.size}", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@Composable
private fun GoogleReplayMap(all: List<PingDto>, shown: List<PingDto>) {
    val allPoints = all.map { LatLng(it.lat, it.lng) }
    val shownPoints = shown.map { LatLng(it.lat, it.lng) }
    val center = allPoints[allPoints.size / 2]
    val startMarkerState = remember(allPoints.first()) { MarkerState(allPoints.first()) }
    val replayMarkerState = remember(shownPoints.last()) { MarkerState(shownPoints.last()) }
    val cameraState = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(center, 14f)
    }
    var mapLoaded by remember(allPoints) { mutableStateOf(false) }

    LaunchedEffect(mapLoaded, allPoints) {
        if (!mapLoaded) return@LaunchedEffect
        val distinctRoute = allPoints.any { it != allPoints.first() }
        val update = if (allPoints.size > 1 && distinctRoute) {
            val bounds = LatLngBounds.builder().apply { allPoints.forEach(::include) }.build()
            CameraUpdateFactory.newLatLngBounds(bounds, 96)
        } else {
            CameraUpdateFactory.newLatLngZoom(center, 16f)
        }
        cameraState.animate(update)
    }

    Card(Modifier.fillMaxWidth()) {
        GoogleMap(
            modifier = Modifier.fillMaxWidth().height(300.dp),
            cameraPositionState = cameraState,
            uiSettings = MapUiSettings(
                compassEnabled = false,
                mapToolbarEnabled = false,
                zoomControlsEnabled = false,
            ),
            onMapLoaded = { mapLoaded = true },
        ) {
            if (allPoints.size > 1) {
                Polyline(points = allPoints, color = Color(0xFF9E9E9E), width = 8f)
                Polyline(points = shownPoints, color = Color(0xFF1565C0), width = 11f)
            }
            Marker(
                state = startMarkerState,
                title = "Trip started",
                icon = BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_GREEN),
            )
            Marker(
                state = replayMarkerState,
                title = "Current replay position",
                icon = BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_RED),
            )
        }
    }
}

@Composable
private fun OfflineReplayMap(all: List<PingDto>, shown: List<PingDto>) {
    val lats = all.map { it.lat }
    val lngs = all.map { it.lng }
    val minLat = lats.min(); val maxLat = lats.max()
    val minLng = lngs.min(); val maxLng = lngs.max()
    val latSpan = (maxLat - minLat).takeIf { it > 1e-9 } ?: 1e-9
    val lngSpan = (maxLng - minLng).takeIf { it > 1e-9 } ?: 1e-9

    Box(
        Modifier
            .fillMaxWidth()
            .height(300.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Canvas(Modifier.fillMaxSize().padding(24.dp)) {
            val pt: (PingDto) -> Offset = {
                Offset(
                    ((it.lng - minLng) / lngSpan * size.width).toFloat(),
                    (size.height - ((it.lat - minLat) / latSpan * size.height)).toFloat(),
                )
            }
            fun routePath(points: List<PingDto>) = Path().apply {
                points.forEachIndexed { index, ping ->
                    val point = pt(ping)
                    if (index == 0) moveTo(point.x, point.y) else lineTo(point.x, point.y)
                }
            }
            if (all.size > 1) drawPath(routePath(all), Color(0xFF9E9E9E), style = Stroke(width = 8f))
            if (shown.size > 1) drawPath(routePath(shown), Color(0xFF1565C0), style = Stroke(width = 11f))
            drawCircle(Color(0xFF2E7D32), radius = 13f, center = pt(all.first()))
            drawCircle(Color(0xFFE53935), radius = 15f, center = pt(shown.last()))
            drawCircle(Color.White, radius = 6f, center = pt(shown.last()))
        }
    }
}

// ---------------- Alerts ----------------

@Composable
fun AlertsScreen(vm: AlertsViewModel = hiltViewModel(), onBack: (() -> Unit)? = null) {
    LaunchedEffect(Unit) { vm.load() }
    ScreenScaffold("Alerts", onBack) { modifier ->
        Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ErrorRetry(vm.error) { vm.load() }
            if (vm.loading) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            if (!vm.loading && vm.alerts.isEmpty() && vm.error == null) {
                Text("No alerts.", textAlign = TextAlign.Center)
            }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(vm.alerts, key = { it.id }) { alert ->
                    AlertRow(
                        alert = alert,
                        canTriage = vm.canTriage,
                        updating = vm.updatingId == alert.id,
                        onStatus = { vm.setStatus(alert.id, it) },
                    )
                }
            }
        }
    }
}

@Composable
private fun AlertRow(
    alert: AlertDto,
    canTriage: Boolean,
    updating: Boolean,
    onStatus: (String) -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(alert.type, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                AssistChip(onClick = {}, label = { Text(alert.status) })
            }
            Text(fmt(alert.createdAt), style = MaterialTheme.typography.bodySmall)
            alert.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            Text("(%.4f, %.4f)".format(alert.lat, alert.lng), style = MaterialTheme.typography.labelSmall)
            if (canTriage && alert.status != "RESOLVED") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (alert.status == "OPEN") {
                        OutlinedButton(onClick = { onStatus("ACKNOWLEDGED") }, enabled = !updating) {
                            Text("Acknowledge")
                        }
                    }
                    Button(onClick = { onStatus("RESOLVED") }, enabled = !updating) { Text("Resolve") }
                }
            }
        }
    }
}

// ---------------- Profile ----------------

@Composable
private fun PermissionRow(label: String, granted: Boolean, onAllow: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        if (granted) {
            Text("On", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
        } else {
            TextButton(onClick = onAllow) { Text("Allow") }
        }
    }
}

@Composable
private fun PermissionSettingsLink(text: String) {
    val context = LocalContext.current
    TextButton(
        onClick = {
            context.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = android.net.Uri.fromParts("package", context.packageName, null)
                },
            )
        },
    ) {
        Text(text, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
@SuppressLint("InlinedApi")
fun ProfileScreen(vm: ProfileViewModel = hiltViewModel(), onLoggedOut: () -> Unit) {
    LaunchedEffect(Unit) { vm.load() }
    val context = LocalContext.current
    // Recompute permission rows after a system dialog resolves.
    var permTick by remember { mutableIntStateOf(0) }
    val locLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permTick++ }
    val notifLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permTick++ }
    // Re-evaluated on every recomposition (permTick++ above invalidates after a
    // system dialog resolves) so the rows below always reflect the real state.
    val fineLocation = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val notificationsGranted = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED
    permTick.let { /* state write above is what invalidates; read silences unused warning */ }

    ScreenScaffold("Profile") { modifier ->
        Column(
            modifier.verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ErrorRetry(vm.error) { vm.load() }
            val user = vm.user
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(user?.name ?: "…", style = MaterialTheme.typography.titleMedium)
                    Text(user?.email ?: "", style = MaterialTheme.typography.bodySmall)
                    AssistChip(onClick = {}, label = { Text(user?.role ?: "") })
                }
            }

            // §3.3 Profile — notification preferences. Per-
            // alert-type push toggles synced to PATCH /users/me/notification-prefs.
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Notification preferences", style = MaterialTheme.typography.titleMedium)
                    if (vm.prefsError != null) {
                        Text("⚠ ${vm.prefsError}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                    NotificationPrefs.ALERT_TYPES.forEach { type ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                NotificationPrefs.label(type),
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.weight(1f),
                            )
                            Switch(
                                checked = vm.prefs[type] ?: true,
                                enabled = !vm.prefsBusy,
                                onCheckedChange = { vm.setPref(type, it) },
                            )
                        }
                    }
                }
            }

            // Permission status panel: location + notifications are requestable
            // here; background
            // location is requested only right before a trip that needs it.
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Permissions", style = MaterialTheme.typography.titleMedium)
                    PermissionRow("Location", granted = fineLocation) {
                        locLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
                    }
                    PermissionRow("Notifications", granted = notificationsGranted) {
                        notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                    Text(
                        "Background location is requested automatically when you start a trip that needs it.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                    if (!fineLocation || !notificationsGranted) {
                        PermissionSettingsLink("Open system settings")
                    }
                }
            }

            OutlinedButton(onClick = { vm.logout(onLoggedOut) }, modifier = Modifier.fillMaxWidth()) {
                Text("Log out")
            }
        }
    }
}
