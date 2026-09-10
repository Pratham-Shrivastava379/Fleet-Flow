package com.fleetflow.fleet.tracking

import com.google.android.gms.location.Priority
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the bounded location-registration retry policy used by
 * [TrackingService]. No GPS/location mocks: these lock down the retry bounds,
 * exponential backoff, and given-up semantics that fix the silent-failure defect.
 */
class TrackingRegistrationPolicyTest {

    @Test
    fun `first failure retries once with base delay`() {
        assertTrue(TrackingRegistrationPolicy.shouldRetry(1))
        assertEquals(
            TrackingRegistrationPolicy.RETRY_BASE_DELAY_MS,
            TrackingRegistrationPolicy.backoffDelayMs(1),
        )
    }

    @Test
    fun `backoff grows exponentially per attempt`() {
        val base = TrackingRegistrationPolicy.RETRY_BASE_DELAY_MS
        val second = base * TrackingRegistrationPolicy.RETRY_BACKOFF_MULTIPLIER
        val max = TrackingRegistrationPolicy.MAX_REGISTRATION_ATTEMPTS
        assertEquals(base, TrackingRegistrationPolicy.backoffDelayMs(1))
        assertEquals(second, TrackingRegistrationPolicy.backoffDelayMs(2))
        assertEquals(second * 2, TrackingRegistrationPolicy.backoffDelayMs(3))
        // Last allowed attempt within the bound is accepted.
        TrackingRegistrationPolicy.backoffDelayMs(max) // no throw
    }

    @Test
    fun `retries are finite - stops before exceeding max`() {
        val max = TrackingRegistrationPolicy.MAX_REGISTRATION_ATTEMPTS
        // A failure at every attempt 1..(max-1) still gets one more retry...
        for (attempt in 1 until max) {
            assertTrue("expected retry after $attempt failures", TrackingRegistrationPolicy.shouldRetry(attempt))
        }
        // ...but once max failures are reached there are no more retries.
        assertFalse(
            "must not retry after reaching MAX_REGISTRATION_ATTEMPTS",
            TrackingRegistrationPolicy.shouldRetry(max),
        )
        assertFalse(
            "must never retry beyond MAX_REGISTRATION_ATTEMPTS",
            TrackingRegistrationPolicy.shouldRetry(max + 1),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun `backoff rejects out of range attempt`() {
        TrackingRegistrationPolicy.backoffDelayMs(0)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `backoff rejects attempt beyond max`() {
        TrackingRegistrationPolicy.backoffDelayMs(TrackingRegistrationPolicy.MAX_REGISTRATION_ATTEMPTS + 1)
    }

    @Test
    fun `priority labels are stable for logging`() {
        assertEquals("BALANCED", TrackingRegistrationPolicy.priorityLabel(Priority.PRIORITY_BALANCED_POWER_ACCURACY))
        assertEquals("HIGH_ACCURACY", TrackingRegistrationPolicy.priorityLabel(Priority.PRIORITY_HIGH_ACCURACY))
        assertEquals("LOW_POWER", TrackingRegistrationPolicy.priorityLabel(Priority.PRIORITY_LOW_POWER))
    }

    @Test
    fun `unknown priority maps to labelled fallback`() {
        val label = TrackingRegistrationPolicy.priorityLabel(Int.MAX_VALUE)
        assertTrue(label.startsWith("UNKNOWN("))
    }

    @Test
    fun `policy constants are sane`() {
        assertTrue(TrackingRegistrationPolicy.MAX_REGISTRATION_ATTEMPTS in 2..10)
        assertTrue(TrackingRegistrationPolicy.RETRY_BASE_DELAY_MS in 500..10_000)
        assertTrue(TrackingRegistrationPolicy.RETRY_BACKOFF_MULTIPLIER >= 2)
        // Sanity: never allows an unbounded (infinite) retry.
        val attemptsToGiveUp = (1..TrackingRegistrationPolicy.MAX_REGISTRATION_ATTEMPTS).count {
            TrackingRegistrationPolicy.shouldRetry(it)
        }
        assertTrue(attemptsToGiveUp < TrackingRegistrationPolicy.MAX_REGISTRATION_ATTEMPTS)
    }
}