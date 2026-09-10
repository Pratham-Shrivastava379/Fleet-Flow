package com.fleetflow.fleet

import com.fleetflow.fleet.data.TripRepository
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

/**
 * §3b offline-finish reliability: an orphaned/deleted trip's queued pings must
 * NOT strand the sync. If a permanently-failing batch keeps `remaining > 0`,
 * SyncWorker RETRY-loops and the CURRENT trip's pendingFinish never completes
 * (observed live: stale queued pings for a nonexistent trip returned HTTP 404
 * "Trip not found" forever, deadlocking the finish of the active trip).
 *
 * The terminal classifier is a pure companion function so this policy is locked
 * on the JVM with no database / device.
 */
class SyncTerminalPolicyTest {

    /** Build an [HttpException] with the given HTTP status via a Retrofit Response. */
    private fun httpError(code: Int, body: String = "boom"): HttpException =
        HttpException(Response.error<Unit>(code, body.toResponseBody("application/json".toMediaType())))

    @Test
    fun `HTTP 404 trip not found is terminal`() {
        assertTrue(TripRepository.isTerminalTripGone(httpError(404, "Trip not found")))
    }

    @Test
    fun `HTTP 409 not-active is terminal`() {
        assertTrue(TripRepository.isTerminalTripGone(httpError(409, "trip is not active")))
    }

    @Test
    fun `HTTP 409 blank body is terminal`() {
        assertTrue(TripRepository.isTerminalTripGone(httpError(409, "")))
    }

    @Test
    fun `transient 5xx is NOT terminal`() {
        assertFalse(TripRepository.isTerminalTripGone(httpError(500)))
    }

    @Test
    fun `non-http failure is NOT terminal`() {
        assertFalse(TripRepository.isTerminalTripGone(RuntimeException("io outage")))
    }

    @Test
    fun `null failure is NOT terminal`() {
        assertFalse(TripRepository.isTerminalTripGone(null))
    }
}