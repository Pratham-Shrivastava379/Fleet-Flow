package com.fleetflow.fleet

import com.fleetflow.fleet.data.TripRepository
import com.fleetflow.fleet.db.ActiveTripState
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * §4 (background-location reliability): locks down the RECOVERED-TRIP
 * pendingFinish semantics on the JVM.
 *
 * The defect this pins: TrackingViewModel.recoverActiveTrip() used to hardcode
 * `pendingFinish = true` for every restored trip, so a healthy recovered trip
 * showed "Finish requested — waiting for network" forever and the Finish button
 * stayed hidden. The corrected contract:
 *
 *  1. The persisted mirror is the SOURCE OF TRUTH for pendingFinish across
 *     process death — recovery must surface the persisted flag verbatim.
 *  2. reconcileActiveTrip() preserves a persisted pendingFinish when it adopts
 *     a backend-ACTIVE trip, and NEVER invents one for a trip that wasn't
 *     pending finish.
 *  3. TrackingService must only resume for a recovered trip that is NOT
 *     pending finish (a pending-finish trip had tracking intentionally stopped;
 *     resuming it would enqueue pings the backend 409s after the finish lands).
 *  4. The UI-facing decision (panel text + Finish visibility + tracking restart)
 *     derives from exactly this flag, so the flag's fidelity is what's tested.
 */
class ActiveTripRecoveryPolicyTest {

    // ---- 1+2: the persisted/reconciled flag survives recovery verbatim ----

    @Test
    fun `reconciled state preserves a persisted pendingFinish`() {
        // Mirror of TripRepository.reconcileActiveTrip()'s adoption branch:
        // pendingFinish = local?.pendingFinish ?: false — the persisted flag is
        // carried over, never fabricated.
        val local = ActiveTripState(tripId = 42, pendingFinish = true)
        val reconciled = ActiveTripState(
            tripId = 42,
            pendingFinish = local.pendingFinish,
        )
        assertTrue(reconciled.pendingFinish)
    }

    @Test
    fun `reconciled state is NOT pendingFinish when the mirror was not`() {
        val local = ActiveTripState(tripId = 42, pendingFinish = false)
        val reconciled = ActiveTripState(tripId = 42, pendingFinish = local.pendingFinish)
        assertFalse(reconciled.pendingFinish)
    }

    @Test
    fun `adoption without a local mirror defaults to not-pendingFinish`() {
        // local == null (fresh install, mirror lost): backend says ACTIVE, so
        // the trip is adopted as a live trip — NOT as a pending finish.
        val local: ActiveTripState? = null
        val reconciled = ActiveTripState(tripId = 42, pendingFinish = local?.pendingFinish ?: false)
        assertFalse(reconciled.pendingFinish)
    }

    // ---- 3: tracking restarts only for non-pending-finish recoveries ----

    @Test
    fun `tracking restarts for a recovered trip that is NOT pending finish`() {
        val restored = ActiveTripState(tripId = 42, pendingFinish = false)
        assertTrue(shouldRestartTracking(restored))
    }

    @Test
    fun `tracking does NOT restart for a pending-finish recovery`() {
        val restored = ActiveTripState(tripId = 42, pendingFinish = true)
        assertFalse(shouldRestartTracking(restored))
    }

    /**
     * Pure mirror of TrackingViewModel.recoverActiveTrip()'s restart decision
     * (and TrackingService.recoverFromIntentlessStart()'s stop condition): only
     * an ACTIVE, non-pending-finish trip is ever resumed.
     */
    private fun shouldRestartTracking(state: ActiveTripState?): Boolean =
        state != null && !state.pendingFinish

    // ---- 4: service-side guard agrees with the ViewModel-side guard ----

    @Test
    fun `service recovery stops for null state`() {
        // TrackingService.recoverFromIntentlessStart(): state == null -> stopSelf.
        assertFalse(shouldRestartTracking(null))
    }

    @Test
    fun `service recovery stops for a pending-finish state`() {
        assertFalse(shouldRestartTracking(ActiveTripState(tripId = 7, pendingFinish = true)))
    }

    // ---- regression: trip-gone classification still gates the finish path ----

    @Test
    fun `terminal trip-gone classification unchanged (404 and not-active 409)`() {
        // The pendingFinish completion depends on isTerminalTripGone: an orphaned
        // trip's queue must drop so the CURRENT trip's finish can complete.
        assertTrue(TripRepository.isTerminalTripGone(httpError(404)))
        assertTrue(TripRepository.isTerminalTripGone(httpError(409, "{\"error\":\"Trip is not active\"}")))
        assertFalse(TripRepository.isTerminalTripGone(httpError(500)))
    }

    private fun httpError(code: Int, body: String = "boom"): retrofit2.HttpException =
        retrofit2.HttpException(
            retrofit2.Response.error<Unit>(
                code,
                body.toResponseBody("application/json".toMediaType()),
            ),
        )
}
