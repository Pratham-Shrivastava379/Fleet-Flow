package com.fleetflow.fleet.screens

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fleetflow.fleet.data.AlertDto
import com.fleetflow.fleet.data.AdminUserDto
import com.fleetflow.fleet.data.AuditLogDto
import com.fleetflow.fleet.data.AuthRepository
import com.fleetflow.fleet.data.CreateGeofenceRequest
import com.fleetflow.fleet.data.GeofenceDto
import com.fleetflow.fleet.data.NotificationPrefs
import com.fleetflow.fleet.data.TripDetailDto
import com.fleetflow.fleet.data.TripListItemDto
import com.fleetflow.fleet.data.TripRepository
import com.fleetflow.fleet.data.TripStatsDto
import com.fleetflow.fleet.data.UserDto
import com.fleetflow.fleet.data.VehicleDto
import com.fleetflow.fleet.db.TokenStore
import com.fleetflow.fleet.push.PushTokenSync
import com.fleetflow.fleet.tracking.SyncWorker
import com.fleetflow.fleet.tracking.TrackingService
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import kotlinx.coroutines.launch

/** Trip History (Phase 9 §3.3): driver's own trips, newest first. */
@HiltViewModel
class TripsViewModel @Inject constructor(private val repo: TripRepository) : ViewModel() {
    var trips by mutableStateOf<List<TripListItemDto>>(emptyList()); private set
    var loading by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set

    fun load() {
        loading = true; error = null
        viewModelScope.launch {
            repo.listTrips()
                .onSuccess { trips = it.items; loading = false }
                .onFailure { loading = false; error = it.message ?: "Network error" }
        }
    }
}

/** Trip Detail with map replay (Phase 9 §3.3/§3.5): pings + stored stats. */
@HiltViewModel
class TripDetailViewModel @Inject constructor(private val repo: TripRepository) : ViewModel() {
    var trip by mutableStateOf<TripDetailDto?>(null); private set
    var stats by mutableStateOf<TripStatsDto?>(null); private set
    var loading by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set

    fun load(tripId: Int) {
        loading = true; error = null
        viewModelScope.launch {
            repo.getTrip(tripId)
                .onSuccess { trip = it; loading = false }
                .onFailure { loading = false; error = it.message ?: "Network error" }
            repo.getTripStats(tripId).onSuccess { stats = it }
        }
    }
}

/** Alerts inbox (Phase 9 §3.3). */
@HiltViewModel
class AlertsViewModel @Inject constructor(
    private val repo: TripRepository,
    tokenStore: TokenStore,
) : ViewModel() {
    var alerts by mutableStateOf<List<AlertDto>>(emptyList()); private set
    var loading by mutableStateOf(false); private set
    var updatingId by mutableStateOf<Int?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    val canTriage: Boolean = tokenStore.role == "ADMIN" || tokenStore.role == "FLEET_MANAGER"

    fun load() {
        loading = true; error = null
        viewModelScope.launch {
            repo.listAlerts()
                .onSuccess { alerts = it; loading = false }
                .onFailure { loading = false; error = it.message ?: "Network error" }
        }
    }

    fun setStatus(id: Int, status: String) {
        updatingId = id; error = null
        viewModelScope.launch {
            repo.updateAlertStatus(id, status)
                .onSuccess { updated ->
                    alerts = alerts.map { if (it.id == id) updated else it }
                    updatingId = null
                }
                .onFailure { updatingId = null; error = it.message ?: "Could not update alert" }
        }
    }
}

/** Role-aware native operations data used by manager/admin destinations. */
@HiltViewModel
class FleetOperationsViewModel @Inject constructor(
    private val repo: TripRepository,
    private val tokenStore: TokenStore,
) : ViewModel() {
    val role: String get() = tokenStore.role ?: "FLEET_MANAGER"
    val isAdmin: Boolean get() = role == "ADMIN"
    var user by mutableStateOf<UserDto?>(null); private set
    var activeTrips by mutableStateOf<List<TripListItemDto>>(emptyList()); private set
    var vehicles by mutableStateOf<List<VehicleDto>>(emptyList()); private set
    var alerts by mutableStateOf<List<AlertDto>>(emptyList()); private set
    var geofences by mutableStateOf<List<GeofenceDto>>(emptyList()); private set
    var users by mutableStateOf<List<AdminUserDto>>(emptyList()); private set
    var auditLogs by mutableStateOf<List<AuditLogDto>>(emptyList()); private set
    var loading by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var actionBusy by mutableStateOf(false); private set
    var actionMessage by mutableStateOf<String?>(null); private set

    fun load() {
        loading = true; error = null
        viewModelScope.launch {
            val failures = mutableListOf<String>()
            repo.me().onSuccess { user = it }.onFailure { failures += "profile" }
            repo.listActiveTrips().onSuccess { activeTrips = it }.onFailure { failures += "live fleet" }
            repo.loadVehicles().onSuccess { vehicles = it }.onFailure { failures += "vehicles" }
            repo.listAlerts().onSuccess { alerts = it }.onFailure { failures += "alerts" }
            repo.listGeofences().onSuccess { geofences = it }.onFailure { failures += "geofences" }
            repo.listAdminUsers().onSuccess { users = it }.onFailure { failures += "users" }
            if (isAdmin) repo.listAuditLogs().onSuccess { auditLogs = it }.onFailure { failures += "audit log" }
            loading = false
            error = failures.takeIf { it.isNotEmpty() }?.joinToString(prefix = "Could not load: ")
        }
    }

    fun addVehicle(plate: String, model: String, onSuccess: () -> Unit = {}) {
        actionBusy = true; actionMessage = null
        viewModelScope.launch {
            repo.createVehicle(plate.trim().uppercase(), model.trim())
                .onSuccess {
                    vehicles = vehicles + it
                    actionBusy = false
                    actionMessage = "Vehicle ${it.plate} added"
                    onSuccess()
                }
                .onFailure { actionBusy = false; actionMessage = it.message ?: "Could not add vehicle" }
        }
    }

    fun setVehicleStatus(id: Int, status: String) {
        actionBusy = true; actionMessage = null
        viewModelScope.launch {
            repo.updateVehicleStatus(id, status)
                .onSuccess { updated ->
                    vehicles = vehicles.map { if (it.id == id) updated else it }
                    actionBusy = false
                    actionMessage = "Vehicle status updated"
                }
                .onFailure { actionBusy = false; actionMessage = it.message ?: "Could not update vehicle" }
        }
    }

    fun assignVehicle(id: Int, driverId: Int?) {
        actionBusy = true; actionMessage = null
        viewModelScope.launch {
            repo.assignVehicle(id, driverId)
                .onSuccess { updated ->
                    vehicles = vehicles.map { if (it.id == id) updated else it }
                    actionBusy = false
                    actionMessage = if (driverId == null) "Driver assignment cleared" else "Driver assigned"
                }
                .onFailure { actionBusy = false; actionMessage = it.message ?: "Could not assign driver" }
        }
    }

    fun addDriver(email: String, name: String, password: String, onSuccess: () -> Unit = {}) {
        actionBusy = true; actionMessage = null
        viewModelScope.launch {
            repo.createDriver(email.trim().lowercase(), name.trim(), password)
                .onSuccess {
                    users = listOf(it) + users
                    actionBusy = false
                    actionMessage = "Driver ${it.name} added"
                    onSuccess()
                }
                .onFailure { actionBusy = false; actionMessage = it.message ?: "Could not add driver" }
        }
    }

    fun setUserDeactivated(id: Int, deactivated: Boolean) {
        actionBusy = true; actionMessage = null
        viewModelScope.launch {
            repo.setUserDeactivated(id, deactivated)
                .onSuccess { updated ->
                    users = users.map { if (it.id == id) updated else it }
                    actionBusy = false
                    actionMessage = if (deactivated) "Driver deactivated" else "Driver reactivated"
                }
                .onFailure { actionBusy = false; actionMessage = it.message ?: "Could not update driver" }
        }
    }

    fun addGeofence(
        name: String,
        lat: Double,
        lng: Double,
        radiusM: Double,
        alertOnEnter: Boolean,
        alertOnExit: Boolean,
        onSuccess: () -> Unit = {},
    ) {
        actionBusy = true; actionMessage = null
        viewModelScope.launch {
            repo.createGeofence(CreateGeofenceRequest(name.trim(), lat, lng, radiusM, alertOnEnter, alertOnExit))
                .onSuccess {
                    geofences = geofences + it
                    actionBusy = false
                    actionMessage = "Geofence ${it.name} created"
                    onSuccess()
                }
                .onFailure { actionBusy = false; actionMessage = it.message ?: "Could not create geofence" }
        }
    }

    fun setGeofenceActive(id: Int, active: Boolean) {
        actionBusy = true; actionMessage = null
        viewModelScope.launch {
            repo.setGeofenceActive(id, active)
                .onSuccess { updated ->
                    geofences = geofences.map { if (it.id == id) updated else it }
                    actionBusy = false
                    actionMessage = if (active) "Geofence activated" else "Geofence paused"
                }
                .onFailure { actionBusy = false; actionMessage = it.message ?: "Could not update geofence" }
        }
    }
}

/**
 * Profile identity, notification preferences, and logout. FCM device-token
 * unregistration runs BEFORE the
 * local tokens are cleared so the DELETE request is still authorized.
 */
@HiltViewModel
class ProfileViewModel @Inject constructor(
    private val repo: TripRepository,
    private val tokenStore: TokenStore,
    private val authRepository: AuthRepository,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    var user by mutableStateOf<UserDto?>(null); private set
    var error by mutableStateOf<String?>(null); private set

    // Per-alert-type push toggles; absent rows default to enabled (merged in
    // the repository against NotificationPrefs.defaults(), §10.2).
    var prefs by mutableStateOf<Map<String, Boolean>>(NotificationPrefs.defaults()); private set
    var prefsError by mutableStateOf<String?>(null); private set
    var prefsBusy by mutableStateOf(false); private set

    fun load() {
        error = null
        prefsError = null
        viewModelScope.launch {
            repo.me()
                .onSuccess { user = it; error = null }
                .onFailure { error = it.message ?: "Network error" }
            repo.listNotificationPrefs()
                .onSuccess { prefs = it; prefsError = null }
                .onFailure { prefsError = it.message ?: "Could not load notification preferences" }
        }
    }

    fun setPref(type: String, enabled: Boolean) {
        val optimistic = prefs + (type to enabled)
        prefs = optimistic
        prefsBusy = true
        viewModelScope.launch {
            repo.setNotificationPrefs(optimistic)
                .onSuccess { prefsBusy = false; prefsError = null }
                .onFailure { prefsBusy = false; prefsError = it.message ?: "Could not save preference" }
        }
    }

    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            // 1. Server-side device unregistration (authorized by the still-present
            // access token) before we clear local credentials. Fail-open: an
            // unconfigured-FCM or network hiccup must not block logout.
            PushTokenSync.unregisterCurrentToken(context)
            // 2. Stop an in-flight trip foreground service so a logout can never
            // leave location capture running against cleared credentials
            // (review fix: logout tracking/state cleanup).
            TrackingService.stop(context)
            // 3. Clear the active-trip mirror + queued pings and cancel the
            // periodic sync — otherwise the next login restores the previous
            // driver's trip/queue (review fix: state isolation across sessions).
            SyncWorker.cancel(context)
            repo.clearActiveTrip()
            // 4. Credentials + queue last (AuthRepository owns tokenStore.clear()
            // and queuedPingDao.clearAll()).
            authRepository.logout()
            onDone()
        }
    }
}
