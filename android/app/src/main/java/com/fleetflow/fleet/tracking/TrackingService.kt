package com.fleetflow.fleet.tracking

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.os.Build
import android.os.Looper
import android.annotation.SuppressLint
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.fleetflow.fleet.MainActivity
import com.fleetflow.fleet.R
import com.fleetflow.fleet.data.TripRepository
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch

/**
 * One delivered location fix, streamed to observers (the Tracking screen feeds it
 * into the route polyline + SOS last-known coordinates via TrackingViewModel).
 * [tripId] lets subscribers drop fixes from a DIFFERENT trip than the one they
 * show (the process-wide stream can carry a replayed fix from a previous trip).
 */
data class LocationFix(
    val lat: Double,
    val lng: Double,
    val speedKmh: Double,
    val headingDeg: Double,
    val accuracyM: Double,
    val recordedAt: Long,
    val tripId: Int = 0,
)

/** EntryPoint for non-Hilt-managed services (foreground Service, Phase 8). */
@EntryPoint
@InstallIn(SingletonComponent::class)
interface TrackingRepositoryEntryPoint {
    fun tripRepository(): TripRepository
}

/**
 * Foreground service for active-trip tracking.
 *
 * Design decisions (per JD: battery + reliability):
 *  - FusedLocationProviderClient with BALANCED_POWER_ACCURACY and ~5s interval —
 *    high-accuracy PRIORITY_HIGH_ACCURACY is reserved for when speed quality matters.
 *  - Every fix is enqueued locally (Room/SQLite) then synced by SyncWorker, so a
 *    dead network never loses data.
 *  - foregroundServiceType="location" + FGS_LOCATION permission (API 34+ rules).
 */
class TrackingService : LifecycleService() {

    private var tripId: Int = -1
    private lateinit var fused: FusedLocationProviderClient

    // Phase 10 adaptive location (§8.2): recompute the request profile when the
    // moving/stationary state or the SOS override flips.
    private var moving = false
    private var sosOverride = false

    // §7 harsh-braking CANDIDATE detection. Accelerometer sampling runs ONLY
    // while a trip is actively tracked (registered with the location request
    // lifecycle, torn down in unregisterLocationUpdates/onDestroy) and stops
    // immediately when the trip ends. The detector is pure + configurable; a
    // fired candidate rides the existing alert flow as an UNVALIDATED
    // HARSH_BRAKING alert (never crash detection — thresholds need calibration).
    private var harshBrakingDetector: HarshBrakingDetector? = null
    private var lastFixLat: Double? = null
    private var lastFixLng: Double? = null

    // Monotonic "generation" for the location-registration chain. Bumped on every
    // applyLocationRequest() and onDestroy() so async remove/request Tasks and any
    // pending retry from an older configuration are ignored — this prevents both
    // duplicate active subscriptions and stale retries firing after stop/destroy.
    private var registrationGeneration = 0

    // Failures observed so far for the current registration generation (reset on each
    // (re)apply). Drives the bounded retry loop in TrackingRegistrationPolicy.
    private var retryAttempt = 0

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val location = result.lastLocation ?: return
            val nowMoving = location.hasSpeed() && location.speed >= MOVING_SPEED_MPS
            if (nowMoving != moving) {
                moving = nowMoving
                applyLocationRequest()
            }
            handleFix(location)
        }
    }

    /** §7 sensor listener: feeds the pure detector; never mutates tracking state. */
    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            val detector = harshBrakingDetector ?: return
            if (tripId <= 0) return
            val ax = event.values.getOrNull(0)?.toDouble() ?: return
            val ay = event.values.getOrNull(1)?.toDouble() ?: return
            val az = event.values.getOrNull(2)?.toDouble() ?: return
            val speedKmh = lastFixSpeedKmh
            val fired = detector.observe(ax, ay, az, speedKmh, System.currentTimeMillis())
            if (fired) onHarshBrakingCandidate()
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    }

    /** Last known speed in km/h from the fused fix (NaN until the first fix). */
    private var lastFixSpeedKmh: Double = Double.NaN

    private fun onHarshBrakingCandidate() {
        val lat = lastFixLat ?: return
        val lng = lastFixLng ?: return
        val trip = tripId
        Log.i(TAG, "HARSH_BRAKING candidate (unvalidated) for trip=$trip")
        lifecycleScope.launch {
            val repo: TripRepository = EntryPointAccessors.fromApplication(
                applicationContext, TrackingRepositoryEntryPoint::class.java,
            ).tripRepository()
            repo.raiseHarshBrakingCandidate(trip, lat, lng)
        }
    }

    /** Register accelerometer sampling (ONLY called with an active trip). */
    private fun registerSensorSampling() {
        if (harshBrakingDetector != null) return // no duplicate registration
        val manager = getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
        val accel = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        harshBrakingDetector = HarshBrakingDetector()
        // SENSOR_DELAY_GAME ≈ 50 Hz — plenty for a deceleration-envelope detector.
        manager.registerListener(sensorListener, accel, SensorManager.SENSOR_DELAY_GAME)
        Log.d(TAG, "Accelerometer sampling registered for harsh-braking detection (trip=$tripId)")
    }

    /** Tear down accelerometer sampling — called on EVERY trip-stop path. */
    private fun unregisterSensorSampling() {
        if (harshBrakingDetector == null) return
        (getSystemService(Context.SENSOR_SERVICE) as? SensorManager)?.unregisterListener(sensorListener)
        harshBrakingDetector = null
        Log.d(TAG, "Accelerometer sampling unregistered (trip=$tripId)")
    }

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_START -> {
                tripId = intent.getIntExtra(EXTRA_TRIP_ID, -1)
                moving = false
                sosOverride = false
                startForegroundCompat()
                applyLocationRequest()
                registerSensorSampling()
            }
            ACTION_SOS -> {
                // §8.2: an SOS flips tracking to PRIORITY_HIGH_ACCURACY at a fast
                // cadence so responders get the freshest, highest-fidelity position.
                sosOverride = true
                applyLocationRequest()
            }
            ACTION_STOP -> {
                // §7: trip over → sensor sampling stops IMMEDIATELY, before the
                // service even stops, so no sample is attributed to a dead trip.
                unregisterSensorSampling()
                tripId = -1
                stopSelf()
            }
            // §4 (background-location reliability): START_REDELIVER_INTENT means the
            // system redelivers the original START intent (with EXTRA_TRIP_ID) when it
            // recreates a killed service, OR may supply a null intent. In the latter
            // case — or any unrecognized action — recover the active trip from the
            // persisted mirror and carry on, but NEVER resume a pending-finish /
            // completed trip (that would enqueue pings the backend would reject).
            null -> recoverFromIntentlessStart()
            else -> recoverFromIntentlessStart()
        }
        // else (null action or unrecognized action) is handled above: recover
        // the active trip from persistence. §4 comment lives at the branch.
        // §4: previously START_NOT_STICKY meant process/service recreation silently
        // stopped tracking forever. STICKY/REDELIVER keeps an active trip alive across
        // recreation — only an ACTIVE, non-pending-finish trip is ever resumed.
        return START_REDELIVER_INTENT
    }

    /** Restore an active (non-pending-finish) trip after service recreation. */
    private fun recoverFromIntentlessStart() {
        lifecycleScope.launch {
            val repo: TripRepository = EntryPointAccessors.fromApplication(
                applicationContext, TrackingRepositoryEntryPoint::class.java,
            ).tripRepository()
            val state = repo.activeTripState()
            if (state == null || state.pendingFinish) {
                // Nothing to restore (no active trip, or finish already requested):
                // stop WITHOUT enqueueing any more pings.
                stopSelf()
                return@launch
            }
            tripId = state.tripId
            moving = false
            sosOverride = false
            startForegroundCompat()
            applyLocationRequest()
            registerSensorSampling()
        }
    }

    private fun startForegroundCompat() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Trip tracking", NotificationManager.IMPORTANCE_LOW)
        )
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Trip in progress")
            .setContentText("FleetFlow is recording your trip location.")
            .setSmallIcon(R.drawable.ic_stat_tracking)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } catch (e: SecurityException) {
                // Android 14+ rejects a location-type FGS when the runtime location
                // grant is missing/revoked in a race with the UI gate (or OEM
                // privacy layers defer it). Crash-looping the whole process on a
                // permission race is wrong: tear the service down gracefully; the
                // UI re-grants and re-starts it when the user actually drives off.
                Log.w(TAG, "Location FGS rejected (location permission not granted) — stopping service", e)
                stopSelf()
            }
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    /**
     * §8.2 adaptive request profile: stationary uses a slow/battery-friendly
     * cadence (a parked delivery van needs no 5s fixes), moving uses the MVP's
     * ~5s balanced interval, and an SOS overrides to PRIORITY_HIGH_ACCURACY at
     * ~2s so the last position is as fresh as possible.
     */
    private fun profile(): LocationRequest {
        val (priority, interval, minInterval, maxDelay) = when {
            sosOverride -> Tuple(Priority.PRIORITY_HIGH_ACCURACY, SOS_INTERVAL_MS, SOS_MIN_INTERVAL_MS, SOS_MAX_DELAY_MS)
            moving -> Tuple(Priority.PRIORITY_BALANCED_POWER_ACCURACY, MOVING_INTERVAL_MS, MOVING_MIN_INTERVAL_MS, MOVING_MAX_DELAY_MS)
            else -> Tuple(Priority.PRIORITY_BALANCED_POWER_ACCURACY, STATIONARY_INTERVAL_MS, STATIONARY_MIN_INTERVAL_MS, STATIONARY_MAX_DELAY_MS)
        }
        return LocationRequest.Builder(priority, interval)
            .setMinUpdateIntervalMillis(minInterval)
            .setMaxUpdateDelayMillis(maxDelay) // batching under Doze/app idle saves battery
            .build()
    }

    /** (priority, interval, minInterval, maxDelay) tiny tuple to avoid 4 field locals. */
    private data class Tuple(
        val priority: Int, val interval: Long,
        val minInterval: Long, val maxDelay: Long,
    )

    private fun applyLocationRequest() {
        if (tripId <= 0) return
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
        if (fine != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "applyLocationRequest: ACCESS_FINE_LOCATION not granted for trip $tripId; stopping tracking (UI will re-prompt)")
            unregisterSensorSampling() // §7: sensor sampling stops with tracking
            stopSelf() // permission revoked mid-trip; UI re-prompts
            return
        }

        // Bump the generation so any in-flight/superseded registration or pending retry
        // from an older configuration is ignored (no duplicate/stale subscriptions).
        val gen = ++registrationGeneration
        retryAttempt = 0
        val req = profile()
        Log.d(
            TAG,
            "applyLocationRequest: trip=$tripId gen=$gen priority=${TrackingRegistrationPolicy.priorityLabel(req.priority)} " +
                "intervalMs=${req.intervalMillis}",
        )

        // Serialise remove -> request: only start the new request once the remove Task has
        // completed. Launching both Tasks back-to-back was a race — the async remove could
        // complete AFTER the new request and silently unregister the just-registered callback.
        fused.removeLocationUpdates(callback)
            .addOnFailureListener { e ->
                Log.w(
                    TAG,
                    "removeLocationUpdates FAILED (continuing to register anyway) trip=$tripId gen=$gen " +
                        "error=${e.javaClass.simpleName}: ${e.message}",
                )
            }
            .addOnCompleteListener {
                if (gen != registrationGeneration) return@addOnCompleteListener
                registerLocationUpdates(gen, req)
            }
    }

    // Caller contract: applyLocationRequest() verifies ACCESS_FINE_LOCATION and
    // stopSelf()s when it's missing; this method only ever runs from the
    // remove-completion continuation of that guarded path, so the permission is
    // guaranteed here. Lint cannot follow the Task-lambda boundary, hence the
    // targeted suppression (a second check here would silently skip
    // registration instead of failing loudly — the guarded caller is the check).
    @SuppressLint("MissingPermission")
    private fun registerLocationUpdates(gen: Int, req: LocationRequest) {
        fused.requestLocationUpdates(req, callback, Looper.getMainLooper())
            .addOnSuccessListener {
                if (gen != registrationGeneration) return@addOnSuccessListener
                retryAttempt = 0
                Log.d(
                    TAG,
                    "Location subscription registered: trip=$tripId gen=$gen " +
                        "priority=${TrackingRegistrationPolicy.priorityLabel(req.priority)} intervalMs=${req.intervalMillis}",
                )
            }
            .addOnFailureListener { e ->
                if (gen != registrationGeneration) return@addOnFailureListener
                retryAttempt++
                Log.w(
                    TAG,
                    "requestLocationUpdates FAILED: trip=$tripId gen=$gen " +
                        "priority=${TrackingRegistrationPolicy.priorityLabel(req.priority)} intervalMs=${req.intervalMillis} " +
                        "attempt=$retryAttempt/${TrackingRegistrationPolicy.MAX_REGISTRATION_ATTEMPTS} " +
                        "error=${e.javaClass.simpleName}: ${e.message}",
                )
                scheduleRetry(gen, req)
            }
    }

    /**
     * Bounded exponential-backoff retry for a failed [registerLocationUpdates]. Runs on the
     * service's lifecycleScope, so the pending delay is automatically cancelled in onDestroy.
     * Re-requesting with the same callback replaces any (failed) prior request, so this never
     * creates a duplicate active subscription; the generation guard also stalls stale retries.
     */
    private fun scheduleRetry(gen: Int, req: LocationRequest) {
        if (gen != registrationGeneration) return
        if (!TrackingRegistrationPolicy.shouldRetry(retryAttempt)) {
            Log.e(
                TAG,
                "Giving up on location registration for trip=$tripId gen=$gen after $retryAttempt attempts " +
                    "(priority=${TrackingRegistrationPolicy.priorityLabel(req.priority)})",
            )
            return
        }
        val delayMs = TrackingRegistrationPolicy.backoffDelayMs(retryAttempt)
        lifecycleScope.launch {
            delay(delayMs)
            if (gen != registrationGeneration) return@launch
            registerLocationUpdates(gen, req)
        }
    }

    private fun handleFix(location: Location) {
        if (tripId <= 0) return
        lastFixLat = location.latitude
        lastFixLng = location.longitude
        lastFixSpeedKmh = location.speed * 3.6
        // Emit for the UI (route polyline, SOS coordinates) BEFORE the enqueue so
        // an early subscriber never sees a replay of the previous fix first.
        fixFlow.tryEmit(
            LocationFix(
                lat = location.latitude,
                lng = location.longitude,
                speedKmh = location.speed * 3.6,
                headingDeg = if (location.hasBearing()) location.bearing.toDouble() else 0.0,
                accuracyM = if (location.hasAccuracy()) location.accuracy.toDouble() else 0.0,
                recordedAt = System.currentTimeMillis(),
                tripId = tripId,
            ),
        )
        lifecycleScope.launch {
            val repo: TripRepository = EntryPointAccessors.fromApplication(
                applicationContext, TrackingRepositoryEntryPoint::class.java,
            ).tripRepository()
            repo.enqueuePing(
                tripId = tripId,
                lat = location.latitude,
                lng = location.longitude,
                speedKmh = location.speed * 3.6,
                headingDeg = if (location.hasBearing()) location.bearing.toDouble() else 0.0,
                accuracyM = if (location.hasAccuracy()) location.accuracy.toDouble() else 0.0,
            )
        }
    }

    override fun onDestroy() {
        // Invalidate any in-flight registration Task or pending retry before tearing down.
        registrationGeneration++
        unregisterSensorSampling() // §7: sampling NEVER outlives the service
        fused.removeLocationUpdates(callback)
            .addOnCompleteListener { Log.d(TAG, "removeLocationUpdates completed on destroy (trip=$tripId)") }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "FleetFlowTracking"

        const val ACTION_START = "com.fleetflow.fleet.START_TRACKING"
        const val ACTION_SOS = "com.fleetflow.fleet.SOS_TRACKING"
        const val ACTION_STOP = "com.fleetflow.fleet.STOP_TRACKING"
        const val EXTRA_TRIP_ID = "trip_id"
        private const val CHANNEL_ID = "trip_tracking"
        private const val NOTIF_ID = 42

        // §8.2 adaptive location cadence (ms). Stationary favours battery; moving
        // is the MVP's ~5s balanced profile; SOS forces HIGH_ACCURACY ~2s.
        private const val MOVING_INTERVAL_MS = 5_000L
        private const val MOVING_MIN_INTERVAL_MS = 2_500L
        private const val MOVING_MAX_DELAY_MS = 15_000L
        private const val STATIONARY_INTERVAL_MS = 60_000L
        private const val STATIONARY_MIN_INTERVAL_MS = 15_000L
        private const val STATIONARY_MAX_DELAY_MS = 120_000L
        private const val SOS_INTERVAL_MS = 2_000L
        private const val SOS_MIN_INTERVAL_MS = 1_000L
        private const val SOS_MAX_DELAY_MS = 5_000L

        /** Above this ground speed (m/s ≈ 5.4 km/h) the vehicle is treated as moving. */
        private const val MOVING_SPEED_MPS = 1.5f

        fun start(context: Context, tripId: Int) {
            val intent = Intent(context, TrackingService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_TRIP_ID, tripId)
            ContextCompat.startForegroundService(context, intent)
        }

        /** §8.2: escalate an ongoing trip to high-accuracy tracking (fire-and-forget to the running service). */
        fun sos(context: Context) {
            context.startService(Intent(context, TrackingService::class.java).setAction(ACTION_SOS))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, TrackingService::class.java).setAction(ACTION_STOP))
        }

        /**
 * Process-wide stream of delivered fixes (the
         * on-screen route polyline and SOS last-known coordinates were dead because
         * no fix ever reached the UI). Lives on the companion — NOT on a service
         * instance — so subscribers can attach BEFORE the service starts (e.g. when
         * process death restores an active trip) and still receive every fix, with
         * no subscribe/start race. replay 1 so a late-subscribing screen paints the
         * freshest fix immediately; subscribers filter by [LocationFix.tripId] so a
         * replayed value from a PREVIOUS trip is never mistaken for the current one.
         */
        private val fixFlow = MutableSharedFlow<LocationFix>(replay = 1, extraBufferCapacity = 16)

        /** Subscribe to the live fix stream of whatever trip is being tracked. */
        fun fixes(context: Context): Flow<LocationFix> = fixFlow
    }
}
