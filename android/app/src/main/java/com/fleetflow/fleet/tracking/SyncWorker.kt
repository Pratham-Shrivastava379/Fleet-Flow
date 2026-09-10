package com.fleetflow.fleet.tracking

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.ExistingWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.fleetflow.fleet.data.TripRepository
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import java.util.concurrent.TimeUnit

/** EntryPoint for non-Hilt-managed workers (WorkManager, Phase 8). */
@EntryPoint
@InstallIn(SingletonComponent::class)
interface TripRepositoryEntryPoint {
    fun tripRepository(): TripRepository
}

/**
 * Periodically drains the offline ping queue when connectivity returns.
 * Constraints (CONNECTED) + exponential backoff mean zero wasted battery/radio
 * while offline. In-flight trips also trigger one-shot syncs from the UI layer.
 *
 * Trip-agnostic (offline-sync reliability fix): the worker drains EVERY trip
 * still present in the queue instead of one hard-coded tripId, so starting a
 * new trip can no longer strand an old trip's rows.
 *
 * Pending-finish completion: when a finish was requested while offline, the
 * finish fires here the moment the queue drains — the trip is never left
 * falsely "active", and the finish call itself is retried on the next run if
 * the network drops again.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val repo: TripRepository = EntryPointAccessors.fromApplication(
            applicationContext, TripRepositoryEntryPoint::class.java,
        ).tripRepository()

        // Drain every trip with queued rows (idempotent: the server dedupes by
        // idempotencyKey, so overlap with a UI-triggered sync is harmless).
        val (sent, remaining) = repo.syncAllPending()

        // Once the queue is empty, complete any trip left pending finish.
        if (remaining <= 0) {
            val state = repo.activeTripState()
            if (state?.pendingFinish == true) {
                repo.finishTrip(state.tripId)
                    .onSuccess {
                        repo.clearActiveTrip()
                        cancel(applicationContext)
                    }
                    // Failure (still offline / server error): pendingFinish
                    // stays set and the next run retries — never falsely
                    // mark the trip as completed locally.
                    .onFailure { /* retried on the next worker run */ }
            }
        }
        return if (remaining > 0) Result.retry() else Result.success()
    }

    companion object {
        const val KEY_TRIP_ID = "trip_id" // legacy input key (kept for compatibility)
        private const val WORK_NAME = "ping_sync"
        private const val ONESHOT_WORK_NAME = "ping_sync_now"

        fun schedule(context: Context, tripId: Int) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request,
            )
        }

        /** One-shot drain as soon as any network is available (UI/recovery path). */
        fun enqueueOneShot(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONESHOT_WORK_NAME, ExistingWorkPolicy.REPLACE, request,
            )
        }

        /** Cancel all sync work once the active trip is finished and drained. */
        fun cancel(context: Context) {
            val wm = WorkManager.getInstance(context)
            wm.cancelUniqueWork(WORK_NAME)
            wm.cancelUniqueWork(ONESHOT_WORK_NAME)
        }
    }
}
