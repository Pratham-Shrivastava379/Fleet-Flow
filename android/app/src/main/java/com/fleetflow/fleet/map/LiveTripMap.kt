package com.fleetflow.fleet.map

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.LatLng
import com.google.maps.android.compose.CameraMoveStartedReason
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.Marker
import com.google.maps.android.compose.MarkerState
import com.google.maps.android.compose.Polyline
import com.google.maps.android.compose.rememberCameraPositionState
import com.fleetflow.fleet.BuildConfig

/**
 * Live Google Maps surface for the active-trip screen.
 *
 * Provider-neutral contract: when no GOOGLE_MAPS_KEY is configured (fresh clone /
 * CI) a lightweight status card renders instead of a map — the rest of the app
 * still builds and runs without a real key, and CI never needs one to pass. The
 * key is read at build time ONLY from android/local.properties and is never
 * committed, printed or exposed.
 *
 * [current] is the vehicle marker position; [route] the recorded polyline;
 * [follow] is the camera-intent flag driven by the ViewModel.
 *
 * Gesture behaviour (review fix): the camera intent flips OFF as soon as the
 * USER pans/zooms the map (camera move started with [CameraMoveStartedReason.GESTURE])
 * — API-driven animation from the follow effect itself never counts as a gesture.
 * The banner reflects the live intent and a tap on it re-engages following.
 * While the camera has never been positioned (no fix yet) a loading chip shows.
 */
@Composable
fun LiveTripMap(
    current: LatLng?,
    route: List<LatLng>,
    follow: Boolean,
    onFollowChange: (Boolean) -> Unit = {},
) {
    if (BuildConfig.GOOGLE_MAPS_KEY.isBlank()) {
        NoKeyCard(
            "Set GOOGLE_MAPS_KEY in android/local.properties to render the live map. " +
                "Tracking, alerts and the rest of the app keep working without it.",
        )
        return
    }

    // Initial camera: fit the current fix if known, else a sensible default.
    val start = current ?: LatLng(12.9716, 77.5946)
    val cameraState = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(start, 15f)
    }
    // Camera has never been centered on a fix yet (no position update arrived).
    var cameraSettled by remember { mutableStateOf(false) }
    val tripStartMarkerState = route.firstOrNull()?.let { position ->
        remember(position) { MarkerState(position) }
    }
    val currentMarkerState = current?.let { position ->
        remember(position) { MarkerState(position) }
    }

    // USER GESTURE → stop following. moveStartedReason distinguishes the user's
    // pan/zoom (GESTURE) from this composable's own programmatic recenter, so the
    // follow loop can never switch itself off (review finding). A gesture also
    // means the camera IS settled — the waiting-for-fix chip must not linger.
    LaunchedEffect(cameraState) {
        snapshotFlow { cameraState.isMovingByGesture }
            .collect { moved ->
                if (moved) {
                    cameraSettled = true
                    onFollowChange(false)
                }
            }
    }

    // Only recenter while follow is on; turning it off leaves the user's camera alone.
    LaunchedEffect(current, follow) {
        if (follow && current != null) {
            cameraState.position = CameraPosition.fromLatLngZoom(current, 15f)
            cameraSettled = true
        }
    }

    Box(Modifier.fillMaxWidth().height(220.dp)) {
        GoogleMap(
            modifier = Modifier.fillMaxWidth().height(220.dp),
            cameraPositionState = cameraState,
        ) {
            if (route.isNotEmpty() && tripStartMarkerState != null) {
                Polyline(points = route)
                // Trip origin marker (review finding: route alone gave no visual
                // anchor for where the trip began).
                Marker(
                    state = tripStartMarkerState,
                    title = "Trip start",
                )
            }
            if (currentMarkerState != null) {
                Marker(state = currentMarkerState, title = "Trip location")
            }
        }
        Row(
            Modifier
                .align(Alignment.TopStart)
                .padding(6.dp),
        ) {
            Card(onClick = { onFollowChange(true) }) {
                Text(
                    when {
                        follow -> "Following vehicle"
                        else -> "Map moved — tap to re-follow"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(6.dp),
                )
            }
        }
        if (!cameraSettled) {
            Row(
                Modifier
                    .align(Alignment.BottomStart)
                    .padding(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Card {
                    Row(
                        Modifier.padding(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(Modifier.height(14.dp).padding(end = 4.dp))
                        Text("Waiting for first fix…", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}

/** True while the camera moves because of a USER gesture (not programmatic). */
private val com.google.maps.android.compose.CameraPositionState.isMovingByGesture: Boolean
    get() = isMoving && cameraMoveStartedReason == CameraMoveStartedReason.GESTURE

@Composable
private fun NoKeyCard(message: String) {
    Card(Modifier.fillMaxWidth().height(200.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Map", style = MaterialTheme.typography.titleMedium)
            Text(message, style = MaterialTheme.typography.bodySmall)
        }
    }
}
