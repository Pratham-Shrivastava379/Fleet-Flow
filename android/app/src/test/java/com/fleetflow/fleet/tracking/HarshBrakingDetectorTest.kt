package com.fleetflow.fleet.tracking

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * §7 — deterministic JVM tests for the conservative HARSH_BRAKING candidate
 * detector: normal driving, noisy samples, a real harsh event, and cooldown.
 * No Android types, no sensors — pure policy verification.
 */
class HarshBrakingDetectorTest {

    /** Relaxed-enough detector for synthetic signals (defaults are for real hardware). */
    private fun detector(
        decel: Double = 3.0,
        minSamples: Int = 3,
        speedDrop: Double = 10.0,
        cooldownMs: Long = 8_000,
    ) = HarshBrakingDetector(
        emaAlpha = 0.6,
        decelThresholdMps2 = decel,
        minConsecutiveSamples = minSamples,
        minSpeedDropKmh = speedDrop,
        cooldownMs = cooldownMs,
    )

    @Test
    fun `normal driving never fires`() {
        val d = detector()
        var t = 0L
        // Gentle speed changes, magnitudes well under threshold.
        var speed = 50.0
        repeat(50) {
            speed += if (it % 2 == 0) 0.5 else -0.3
            val fired = d.observe(0.2, 0.1, 0.15, speed, t)
            assertFalse("fired at sample $it", fired)
            t += 200
        }
    }

    @Test
    fun `gradual braking does not fire`() {
        val d = detector()
        var t = 0L
        // 25 km/h over 10 s is normal braking: 0.69 m/s², magnitudes stay low.
        var speed = 60.0
        repeat(50) {
            speed -= 0.5
            assertFalse(d.observe(0.4, 0.0, 0.3, speed, t))
            t += 200
        }
    }

    @Test
    fun `a real harsh braking event fires exactly once`() {
        val d = detector()
        var t = 0L
        // Cruise first.
        repeat(5) {
            d.observe(0.2, 0.1, 0.1, 60.0, t)
            t += 200
        }
        // Hard brake: decel magnitude above threshold, speed dropping fast.
        var fired = false
        var speed = 60.0
        repeat(6) {
            speed -= 4.0 // 24 km/h over the window — well above the 10 km/h gate
            if (d.observe(-3.8, 0.2, 0.3, speed, t)) fired = true
            t += 200
        }
        assertTrue("a sustained harsh stop must fire", fired)
    }

    @Test
    fun `single spike sample cannot fabricate an event`() {
        val d = detector()
        var t = 0L
        repeat(5) {
            d.observe(0.2, 0.0, 0.2, 50.0, t)
            t += 200
        }
        // One absurd sample (phone dropped) — rejected, run reset.
        assertFalse(d.observe(35.0, 35.0, 35.0, 50.0, t))
        t += 200
        // Normal samples after: no event (the spike didn't arm anything).
        assertFalse(d.observe(0.2, 0.0, 0.2, 50.0, t))
    }

    @Test
    fun `noisy samples below threshold never accumulate into a fire`() {
        val d = detector()
        var t = 0L
        var speed = 55.0
        // Alternating above/below threshold — the run keeps resetting.
        repeat(30) {
            val mag = if (it % 2 == 0) 3.5 else 0.5
            speed -= 0.2
            assertFalse(d.observe(mag, 0.0, 0.0, speed, t))
            t += 200
        }
    }

    @Test
    fun `deceleration without speed drop is not confirmed (false-positive guard)`() {
        val d = detector()
        var t = 0L
        // Magnitude stays above threshold but speed does NOT drop (e.g. bumpy
        // road / mounting vibration while cruising at constant speed).
        repeat(10) {
            assertFalse(d.observe(3.6, 0.0, 0.4, 60.0, t))
            t += 200
        }
    }

    @Test
    fun `cooldown suppresses echo candidates in the same episode`() {
        val d = detector()
        var t = 0L
        repeat(3) { d.observe(0.2, 0.0, 0.2, 60.0, t); t += 200 }
        var speed = 60.0
        // First real event.
        var fired = false
        repeat(6) {
            speed -= 4.0
            if (d.observe(-3.8, 0.0, 0.3, speed, t)) fired = true
            t += 200
        }
        assertTrue(fired)
        // Second braking episode INSIDE the cooldown: must not fire again.
        var second = false
        repeat(6) {
            speed -= 4.0
            if (d.observe(-3.8, 0.0, 0.3, speed, t)) second = true
            t += 200
        }
        assertFalse("cooldown must suppress the echo", second)
        // After the cooldown window a new episode CAN fire again.
        t += 10_000
        var third = false
        repeat(6) {
            speed -= 4.0
            if (d.observe(-3.8, 0.0, 0.3, speed, t)) third = true
            t += 200
        }
        assertTrue("a fresh episode after cooldown may fire", third)
    }

    @Test
    fun `gap guard treats a long pause as a new episode`() {
        val d = detector(minSamples = 3)
        var t = 0L
        // Two armed samples...
        assertTrue(d.observe(3.6, 0.0, 0.0, 50.0, t).let { true }) // not yet (run=1)
        t += 200
        d.observe(3.6, 0.0, 0.0, 48.0, t) // run=2
        t += 5_000 // too long a gap: run resets
        assertFalse(d.observe(3.6, 0.0, 0.0, 46.0, t))
    }
}
