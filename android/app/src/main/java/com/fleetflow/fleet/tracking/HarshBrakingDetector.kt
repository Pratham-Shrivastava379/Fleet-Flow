package com.fleetflow.fleet.tracking

/**
 * §7 — conservative HARSH_BRAKING candidate detector (pure Kotlin, no Android
 * types, fully deterministic and JVM-testable).
 *
 * SCOPE HONESTY: this is a **candidate** detector for driver-coaching and
 * alert-triage triage. It is NOT validated crash detection and must never be
 * presented as such. The thresholds below are engineering defaults that REQUIRE
 * real-world calibration against the target fleet's vehicles and mount points
 * before the alerts are trusted operationally.
 *
 * Design constraints:
 *  - conservative: a candidate fires only when a sustained deceleration spike
 *    is confirmed by BOTH the smoothed accelerometer magnitude AND an
 *    independent speed-drop estimate, with a minimum number of samples;
 *  - configurable: every threshold is a constructor parameter with a default;
 *  - filtered: per-sample EMA smoothing + a spike-rejection bound (a single
 *    absurd sample — e.g. the phone being dropped — cannot fabricate an event);
 *  - debounced: a cooldown after any fired event suppresses echo candidates
 *    from the same braking episode.
 *
 * Feed it consecutive samples from the same trip via [observe]; it returns true
 * exactly when a candidate fires. State is per-instance: create one per trip
 * (TrackingService does) and drop it when the trip ends.
 */
class HarshBrakingDetector(
    /** EMA smoothing factor for |a| magnitude (0 < alpha <= 1; lower = smoother). */
    private val emaAlpha: Double = 0.35,
    /** Smoothed forward-deceleration (m/s²) that must be exceeded to arm a candidate. */
    private val decelThresholdMps2: Double = 4.5,
    /** Minimum consecutive armed samples before a candidate may fire. */
    private val minConsecutiveSamples: Int = 3,
    /** Independent confirmation: required speed drop (km/h) across the armed window. */
    private val minSpeedDropKmh: Double = 12.0,
    /** Reject any single sample whose |a| exceeds this (phone drop / mounting slap). */
    private val spikeRejectMps2: Double = 40.0,
    /** Cooldown after a fired candidate; samples inside it cannot fire again. */
    private val cooldownMs: Long = 8_000,
    /** Timestamp window (ms) within which consecutive samples still count. */
    private val maxGapMs: Long = 1_500,
) {
    private var emaMagnitude: Double = Double.NaN
    private var armedRun = 0
    private var armedStartSpeedKmh: Double = Double.NaN
    private var armedStartTimeMs: Long = Long.MIN_VALUE
    private var lastFireAtMs: Long = Long.MIN_VALUE

    /**
     * One accelerometer+speed sample. [axMps2]/[ayMps2]/[azMps2] are the linear
     * accelerometer axes in m/s² (device frame — only the magnitude is used, so
     * mount orientation does not matter); [speedKmh] is the fused location speed
     * at the same instant; [atMs] is the sample timestamp.
     *
     * @return true ONLY when a conservative HARSH_BRAKING candidate fires.
     */
    fun observe(
        axMps2: Double,
        ayMps2: Double,
        azMps2: Double,
        speedKmh: Double,
        atMs: Long,
    ): Boolean {
        val magnitude = kotlin.math.sqrt(axMps2 * axMps2 + ayMps2 * ayMps2 + azMps2 * azMps2)

        // Spike rejection: a single absurd sample (drop, slap, mounting jolt)
        // resets the run instead of arming it.
        if (magnitude > spikeRejectMps2) {
            resetRun()
            return false
        }

        // Cooldown: inside the window after a fired event nothing new can fire.
        if (lastFireAtMs != Long.MIN_VALUE && atMs - lastFireAtMs < cooldownMs) {
            resetRun()
            return false
        }

        // Gap guard: samples too far apart are a new episode, not a continuation.
        if (armedStartSpeedKmh.isFinite() && atMs - armedStartTimeMs > maxGapMs) {
            resetRun()
        }

        // EMA smoothing of the magnitude.
        emaMagnitude = if (emaMagnitude.isNaN()) magnitude else emaAlpha * magnitude + (1 - emaAlpha) * emaMagnitude

        // "Deceleration" here = the smoothed magnitude exceeding the threshold.
        // A vehicle braking hard shows a large horizontal deceleration; the
        // speed-drop confirmation below is what keeps road bumps out.
        val armed = emaMagnitude >= decelThresholdMps2
        if (!armed) {
            resetRun()
            return false
        }

        if (armedRun == 0) {
            armedStartSpeedKmh = speedKmh
            armedStartTimeMs = atMs
        }
        armedRun++

        if (armedRun < minConsecutiveSamples) return false

        val speedDrop = armedStartSpeedKmh - speedKmh
        if (speedDrop >= minSpeedDropKmh) {
            lastFireAtMs = atMs
            resetRun()
            return true
        }
        return false
    }

    private fun resetRun() {
        armedRun = 0
        armedStartSpeedKmh = Double.NaN
        armedStartTimeMs = Long.MIN_VALUE
    }
}
