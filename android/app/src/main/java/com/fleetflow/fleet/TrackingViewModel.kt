package com.fleetflow.fleet

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.maps.model.LatLng
import com.fleetflow.fleet.data.TripRepository
import com.fleetflow.fleet.data.VehicleDto
import com.fleetflow.fleet.tracking.LocationFix
import com.fleetflow.fleet.tracking.SyncWorker
import com.fleetflow.fleet.tracking.TrackingService
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

data class TrackingState(
    val vehicles: List<VehicleDto> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val activeTripId: Int? = null,
    val pendingFinish: Boolean = false,
    val lastLat: Double? = null,
    val lastLng: Double? = null,
    // Maps surface: recorded polyline and camera-follow intent
    // ("waiting for first fix" is derived in the map from a null current fix).
    val route: List<LatLng> = emptyList(),
    val follow: Boolean = true,
)

@HiltViewModel
class TrackingViewModel @Inject constructor(
    private val tripRepository: TripRepository,
    @ApplicationContext private val appContext: android.content.Context,
) : ViewModel() {
    var state by mutableStateOf(TrackingState())
        private set
    init {
        // Single collector of the foreground service's live fix stream (review
        // fix: TrackingService previously exposed no stream, so the route
        // polyline and SOS coordinates never updated from real fixes). Fixes
        // from another trip are dropped: the shared stream can replay a fix
        // recorded before the previous trip finished.
        viewModelScope.launch {
            TrackingService.fixes(appContext).collect { fix ->
                if (fix.tripId == state.activeTripId) updateRoute(fix)
            }
        }
    }

    /**
     * ACTIVE-TRIP RECOVERY (process-restart fix). Called on screen entry:
     *  1. surface any persisted local active trip immediately (offline-safe),
     *  2. reconcile with the backend — a driver-owned ACTIVE trip is adopted
     *     (restores UI state, restarts tracking, restores sync work); "no
     *     backend ACTIVE trip" clears stale local state. Network failure keeps
     *     local state (never destroys a possibly-valid trip).
     *  3. never creates a new trip implicitly.
     */
    fun recoverActiveTrip() {
        scope.launch {
            // Offline-safe first paint from the persisted mirror.
            tripRepository.activeTripState()?.let { local ->
                state = state.copy(
                    activeTripId = local.tripId,
                    pendingFinish = local.pendingFinish,
                )
            }
            val restored = tripRepository.reconcileActiveTrip()
            when {
                restored == null -> {
                    // Backend reachable + no ACTIVE trip: stale local state is
                    // already cleared by the repository.
                    state = state.copy(activeTripId = null, pendingFinish = false)
                }
                else -> {
                    // PENDING-FINISH CORRECTNESS (§4 fix): trust the reconciled
                    // state. reconcileActiveTrip() already preserves the persisted
                    // local pendingFinish flag when adopting a trip — the old
                    // hardcoded `true` here lied on every recovery: a trip that
                    // was NOT pending finish showed "Finish requested — waiting
                    // for network" forever (Finish button hidden), and a trip
                    // that WAS pending finish could look fine after reconcile
                    // dropped the flag. The flag is a persisted fact, not an
                    // optimistic default.
                    state = state.copy(
                        activeTripId = restored.tripId,
                        pendingFinish = restored.pendingFinish,
                    )
                    // Restore sync work for the adopted trip (always).
                    SyncWorker.schedule(appContext, restored.tripId)
                    // Restart tracking only when the trip is NOT pending finish
                    // — a pending-finish trip had tracking intentionally stopped
                    // by the finish flow (restarting it would enqueue pings the
                    // backend would then 409 once the finish lands).
                    if (!restored.pendingFinish) {
                        TrackingService.start(appContext, restored.tripId)
                    }
                }
            }
        }
    }

    fun loadVehicles() {
        state = state.copy(loading = true, error = null)
        scope.launch {
            tripRepository.loadVehicles()
                .onSuccess { state = state.copy(vehicles = it, loading = false) }
                .onFailure { state = state.copy(loading = false, error = it.message ?: "Network error") }
        }
    }

    fun startTrip(vehicleId: Int, onReady: (Int) -> Unit) {
        scope.launch {
            tripRepository.startTrip(vehicleId)
                .onSuccess { id ->
                    // Persist BEFORE anything else: process death between the
                    // backend 201 and the next UI frame must not orphan the trip.
                    tripRepository.setActiveTrip(id)
                    state = state.copy(activeTripId = id, error = null, route = emptyList(), follow = true)
                    SyncWorker.schedule(appContext, id)
                    onReady(id)
                }
                .onFailure { state = state.copy(error = it.message ?: "Could not start trip") }
        }
    }

    /**
     * FINISH TRIP (offline-safe lifecycle):
     *  stop new tracking → sync queued pings → finish backend trip → cancel
     *  obsolete sync work → clear active-trip state.
     *
     * No network / sync failure: the trip moves to a PERSISTED pending-finish
     * state (Room) — the UI keeps showing it as active, and SyncWorker
     * completes the finish the moment the queue drains on reconnect.
     */
    fun finishTrip() {
        val id = state.activeTripId ?: return
        scope.launch {
            // 1. Stop new tracking immediately (no pings past the finish).
            TrackingService.stop(appContext)

            // 2. Try to drain the queue right now (no-op when offline).
            val (_, remaining) = tripRepository.syncPending(id)

            if (remaining > 0) {
                // 3a. Pings still queued (offline / server error): park the
                // trip in pending-finish. SyncWorker finishes it on reconnect.
                tripRepository.setPendingFinish(true)
                SyncWorker.enqueueOneShot(appContext)
                state = state.copy(pendingFinish = true)
                return@launch
            }

            // 3b. Queue drained (or was empty): finish the backend trip.
            tripRepository.finishTrip(id)
                .onSuccess {
                    SyncWorker.cancel(appContext) // 4. obsolete sync work
                    tripRepository.clearActiveTrip() // 5. clear active state
                    state = state.copy(activeTripId = null, pendingFinish = false, route = emptyList())
                }
                .onFailure {
                    // Finish itself failed (network blip): keep pending-finish
                    // so the worker retries; do NOT claim success.
                    tripRepository.setPendingFinish(true)
                    SyncWorker.enqueueOneShot(appContext)
                    state = state.copy(pendingFinish = true)
                }
        }
    }

    fun syncNow() {
        val id = state.activeTripId ?: return
        scope.launch { tripRepository.syncPending(id) }
    }

    /**
     * Single feed from the foreground [TrackingService]: appends the fix to the
     * on-screen route polyline and records the last fix (the map's "waiting for
     * first fix" chip derives from a null current position).
     *
     * Also fixes the review finding on SOS coordinates: `lastLat`/`lastLng` were
     * never written anywhere, so SOS silently fell back to a hard-coded Bangalore
     * point. This is the ONLY writer of the last-fix values — every emitted fix
     * must flow through it so SOS coordinates are always real.
     */
    fun updateRoute(fix: LocationFix) {
        if (state.activeTripId == null) return
        state = state.copy(
            lastLat = fix.lat,
            lastLng = fix.lng,
            route = (state.route + LatLng(fix.lat, fix.lng)).takeLast(MAX_ROUTE_POINTS),
        )
    }

    /** Camera-follow intent (tap the banner to re-engage after a manual drag). */
    fun setFollow(on: Boolean) {
        state = state.copy(follow = on)
    }

    fun sos() {
        val id = state.activeTripId
        scope.launch {
            // §8.2: flips the foreground tracking service to high-accuracy capture
            // BEFORE (or in parallel with) raising the alert, so responders get the
            // freshest possible position.
            TrackingService.sos(appContext)
            tripRepository.raiseSos(id, state.lastLat ?: 12.9716, state.lastLng ?: 77.5946)
        }
    }

    private val scope = CoroutineScope(Dispatchers.Main.immediate)

    private companion object {
        /** Cap on the in-memory route polyline rendered on the live map. */
        const val MAX_ROUTE_POINTS = 1500
    }
}
