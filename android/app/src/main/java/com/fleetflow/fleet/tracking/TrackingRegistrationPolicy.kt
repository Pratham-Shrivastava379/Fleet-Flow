package com.fleetflow.fleet.tracking

import com.google.android.gms.location.Priority

/**
 * Pure, side-effect-free policy for the [TrackingService] location-registration retry
 * loop. Kept free of Android/FusedLocationProviderClient types (only the int `Priority`
 * labels are used) so the bounded-retry and backoff logic can be unit-tested on the JVM
 * without mocking GPS/location behaviour.
 *
 * Design constraints honoured by the service using this policy:
 *  - finite, small retry count (no infinite spinning)
 *  - exponential backoff with a reasonable base delay
 *  - retries are cancelled by the service lifecycle (see TrackingService), never leak
 *  - a retry never creates a duplicate active subscription (serialised remove->request)
 */
internal object TrackingRegistrationPolicy {

    const val MAX_REGISTRATION_ATTEMPTS = 5
    const val RETRY_BASE_DELAY_MS = 2_000L
    const val RETRY_BACKOFF_MULTIPLIER = 2L

    /**
     * Exponential backoff delay for the given one-based attempt number (1..MAX).
     * attempt 1 -> base, attempt 2 -> 2x base, ... capped at MAX.
     */
    fun backoffDelayMs(attempt: Int): Long {
        require(attempt in 1..MAX_REGISTRATION_ATTEMPTS) {
            "attempt must be in 1..$MAX_REGISTRATION_ATTEMPTS but was $attempt"
        }
        var delay = RETRY_BASE_DELAY_MS
        repeat(attempt - 1) { delay *= RETRY_BACKOFF_MULTIPLIER }
        return delay
    }

    /** True if another retry is allowed after the given number of failures so far. */
    fun shouldRetry(failuresSoFar: Int): Boolean =
        failuresSoFar in 1 until MAX_REGISTRATION_ATTEMPTS

    /** Human-readable priority for logs (does not expose coordinates/tokens). */
    fun priorityLabel(priority: Int): String = when (priority) {
        Priority.PRIORITY_HIGH_ACCURACY -> "HIGH_ACCURACY"
        Priority.PRIORITY_BALANCED_POWER_ACCURACY -> "BALANCED"
        Priority.PRIORITY_LOW_POWER -> "LOW_POWER"
        else -> "UNKNOWN($priority)"
    }
}