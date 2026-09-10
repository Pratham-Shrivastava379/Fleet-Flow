package com.fleetflow.fleet.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

// ---- DTOs (mirror backend/src/middleware/validate.js contracts) ----

@Serializable data class LoginRequest(val email: String, val password: String)
// Registration always yields DRIVER server-side (no client-suppliable role —
// the backend ignores/rejects role params; blueprint §5.1) so the field is gone.
@Serializable data class RegisterRequest(val email: String, val password: String, val name: String)
@Serializable data class UserDto(val id: Int, val email: String, val name: String, val role: String)
@Serializable data class AuthResponse(val user: UserDto, val accessToken: String, val refreshToken: String)

@Serializable data class StartTripRequest(val vehicleId: Int)
@Serializable data class FleetLastPositionDto(
    val vehicleId: Int,
    val tripId: Int,
    val driverId: Int,
    val lat: Double,
    val lng: Double,
    val speedKmh: Double = 0.0,
    val headingDeg: Double = 0.0,
    val recordedAt: String,
)
@Serializable data class VehicleDto(
    val id: Int,
    val plate: String,
    val model: String,
    val status: String = "ACTIVE",
    val defaultDriverId: Int? = null,
    val maintenanceNote: String? = null,
    val fleetLastPosition: FleetLastPositionDto? = null,
)
@Serializable data class CreateVehicleRequest(val plate: String, val model: String)
@Serializable data class VehicleStatusRequest(val status: String)
@Serializable data class VehicleDriverRequest(val defaultDriverId: Int?)
@Serializable data class PingRequest(
    val idempotencyKey: String,
    val lat: Double,
    val lng: Double,
    val speedKmh: Double = 0.0,
    val headingDeg: Double = 0.0,
    val accuracyM: Double = 0.0,
    val recordedAt: String,
)
@Serializable data class PingResponse(val duplicate: Boolean = false)

// ---- Phase 10: batch offline sync (§3.6/§4.2) ----
@Serializable data class PingBatchItemError(val idempotencyKey: String, val error: String)
@Serializable data class PingBatchResponse(
    val accepted: Int = 0,
    val duplicates: Int = 0,
    val failed: List<PingBatchItemError> = emptyList(),
)
@Serializable data class PingBatchRequest(val pings: List<PingRequest>)

@Serializable data class AlertRequest(
    val tripId: Int? = null,
    val type: String,
    val lat: Double,
    val lng: Double,
    val detail: String = "",
)

interface ApiService {
    @POST("api/auth/register") suspend fun register(@Body body: RegisterRequest): AuthResponse
    @POST("api/auth/login") suspend fun login(@Body body: LoginRequest): AuthResponse
    @POST("api/auth/refresh") suspend fun refresh(@Body body: Map<String, String>): AuthResponse
    @GET("api/auth/me") suspend fun me(): MeResponse

    @GET("api/vehicles") suspend fun vehicles(): VehiclesResponse
    @POST("api/vehicles") suspend fun createVehicle(@Body body: CreateVehicleRequest): VehicleDto
    @PATCH("api/vehicles/{id}")
    suspend fun updateVehicleStatus(@Path("id") id: Int, @Body body: VehicleStatusRequest): VehicleDto
    @PATCH("api/vehicles/{id}")
    suspend fun assignVehicle(@Path("id") id: Int, @Body body: VehicleDriverRequest): VehicleDto
    @POST("api/trips") suspend fun startTrip(@Body body: StartTripRequest): TripDto
    @POST("api/trips/{id}/pings") suspend fun sendPing(@Path("id") tripId: Int, @Body ping: PingRequest): PingResponse
    @POST("api/trips/{id}/pings/batch")
    suspend fun sendPingBatch(@Path("id") tripId: Int, @Body body: PingBatchRequest): PingBatchResponse
    @POST("api/trips/{id}/finish") suspend fun finishTrip(@Path("id") tripId: Int): TripDto
    @POST("api/alerts") suspend fun raiseAlert(@Body body: AlertRequest)

    // Phase 9 screens (backend already exposes all of these)
    @GET("api/trips") suspend fun trips(
        @Query("page") page: Int = 1,
        @Query("pageSize") pageSize: Int = 20,
        @Query("status") status: String? = null,
    ): TripsResponse
    @GET("api/trips/{id}") suspend fun trip(@Path("id") id: Int): TripDetailDto
    @GET("api/trips/{id}/stats") suspend fun tripStats(@Path("id") id: Int): TripStatsDto
    @GET("api/alerts") suspend fun alerts(): AlertsResponse
    @PATCH("api/alerts/{id}")
    suspend fun updateAlert(@Path("id") id: Int, @Body body: AlertStatusRequest): AlertDto

    // Native fleet-operations destinations. These mirror the manager/admin
    // sections in the web dashboard and remain protected by backend RBAC.
    @GET("api/geofences") suspend fun geofences(): GeofencesResponse
    @POST("api/geofences") suspend fun createGeofence(@Body body: CreateGeofenceRequest): GeofenceDto
    @PATCH("api/geofences/{id}")
    suspend fun updateGeofence(@Path("id") id: Int, @Body body: UpdateGeofenceRequest): GeofenceDto
    @GET("api/users-admin")
    suspend fun adminUsers(
        @Query("page") page: Int = 1,
        @Query("pageSize") pageSize: Int = 100,
    ): AdminUsersResponse
    @POST("api/users-admin") suspend fun createDriver(@Body body: CreateDriverRequest): AdminUserDto
    @PATCH("api/users-admin/{id}")
    suspend fun updateAdminUserStatus(@Path("id") id: Int, @Body body: UserStatusRequest): AdminUserDto
    @GET("api/audit-logs")
    suspend fun auditLogs(
        @Query("page") page: Int = 1,
        @Query("pageSize") pageSize: Int = 50,
    ): AuditLogsResponse

    // ---- Push + notification prefs (blueprint §10, §3.3 Profile) ----
    @GET("api/users/me/notification-prefs")
    suspend fun notificationPrefs(): NotificationPrefsBody
    @PATCH("api/users/me/notification-prefs")
    suspend fun updateNotificationPrefs(@Body body: NotificationPrefsBody): NotificationPrefsBody
    @POST("api/users/me/device-tokens")
    suspend fun registerDeviceToken(@Body body: DeviceTokenBody): DeviceTokenResponse
    @DELETE("api/users/me/device-tokens/{token}")
    suspend fun unregisterDeviceToken(@Path("token") token: String)
}

@Serializable data class MeResponse(val user: UserDto)
@Serializable data class DriverDto(val id: Int, val name: String)
@Serializable data class PingCount(val pings: Int = 0)

@Serializable data class TripsResponse(
    val items: List<TripListItemDto> = emptyList(),
    val page: Int = 1,
    val total: Int = 0,
    val pages: Int = 1,
)

@Serializable data class TripListItemDto(
    val id: Int,
    val status: String,
    val startedAt: String,
    val finishedAt: String? = null,
    val vehicle: VehicleDto? = null,
    val driver: DriverDto? = null,
    @SerialName("_count") val count: PingCount? = null,
)

@Serializable data class PingDto(
    val id: Int,
    val lat: Double,
    val lng: Double,
    val speedKmh: Double = 0.0,
    val headingDeg: Double = 0.0,
    val accuracyM: Double = 0.0,
    val recordedAt: String,
)

@Serializable data class TripDetailDto(
    val id: Int,
    val status: String,
    val startedAt: String,
    val finishedAt: String? = null,
    val vehicle: VehicleDto? = null,
    val driver: DriverDto? = null,
    val distanceKm: Double? = null,
    val avgSpeedKmh: Double? = null,
    val maxSpeedKmh: Double? = null,
    val durationSeconds: Int? = null,
    val pings: List<PingDto> = emptyList(),
)

@Serializable data class TripStatsDto(
    val distanceKm: Double? = null,
    val avgSpeedKmh: Double? = null,
    val maxSpeedKmh: Double? = null,
    val durationSeconds: Int? = null,
)

@Serializable data class AlertsResponse(val items: List<AlertDto> = emptyList())
@Serializable data class AlertStatusRequest(val status: String)

@Serializable data class AlertDto(
    val id: Int,
    val tripId: Int? = null,
    val type: String,
    val status: String,
    val lat: Double,
    val lng: Double,
    val detail: String? = null,
    val createdAt: String,
)

@Serializable data class VehiclesResponse(val items: List<VehicleDto> = emptyList())

@Serializable data class GeofenceDto(
    val id: Int,
    val name: String,
    val centerLat: Double,
    val centerLng: Double,
    val radiusM: Double,
    val active: Boolean = true,
    val alertOnEnter: Boolean = true,
    val alertOnExit: Boolean = true,
    val createdAt: String,
)
@Serializable data class GeofencesResponse(val items: List<GeofenceDto> = emptyList())
@Serializable data class CreateGeofenceRequest(
    val name: String,
    val centerLat: Double,
    val centerLng: Double,
    val radiusM: Double,
    val alertOnEnter: Boolean,
    val alertOnExit: Boolean,
)
@Serializable data class UpdateGeofenceRequest(val active: Boolean)

@Serializable data class AdminUserDto(
    val id: Int,
    val email: String,
    val name: String,
    val role: String,
    val status: String = "ACTIVE",
    val createdAt: String,
)
@Serializable data class AdminUsersResponse(
    val items: List<AdminUserDto> = emptyList(),
    val page: Int = 1,
    val total: Int = 0,
)
@Serializable data class CreateDriverRequest(val email: String, val name: String, val password: String)
@Serializable data class UserStatusRequest(val deactivated: Boolean)

@Serializable data class AuditActorDto(val id: Int, val email: String, val role: String)
@Serializable data class AuditLogDto(
    val id: Int,
    val actorId: Int? = null,
    val action: String,
    val target: String,
    val detail: String = "",
    val createdAt: String,
    val actor: AuditActorDto? = null,
)
@Serializable data class AuditLogsResponse(
    val items: List<AuditLogDto> = emptyList(),
    val page: Int = 1,
    val total: Int = 0,
)
@Serializable data class TripDto(
    val id: Int,
    val status: String,
    val startedAt: String,
    val finishedAt: String? = null,
    val vehicle: VehicleDto? = null,
)

// ---- Notification preferences + FCM device tokens (backend §7/§10) ----

/** One preference row: absent rows mean "enabled" (backend default) — the UI
 *  merges against NotificationPrefs.defaults() before rendering. */
@Serializable data class NotificationPref(val type: String, val enabled: Boolean = true)
@Serializable data class NotificationPrefsBody(val prefs: List<NotificationPref> = emptyList())

@Serializable data class DeviceTokenBody(val token: String, val platform: String = "ANDROID")
@Serializable data class DeviceTokenResponse(val id: Int = 0, val platform: String = "ANDROID")
