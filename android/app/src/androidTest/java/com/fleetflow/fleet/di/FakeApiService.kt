package com.fleetflow.fleet.di

import com.fleetflow.fleet.data.AlertDto
import com.fleetflow.fleet.data.AlertRequest
import com.fleetflow.fleet.data.AlertsResponse
import com.fleetflow.fleet.data.ApiService
import com.fleetflow.fleet.data.AuthResponse
import com.fleetflow.fleet.data.LoginRequest
import com.fleetflow.fleet.data.DeviceTokenBody
import com.fleetflow.fleet.data.DeviceTokenResponse
import com.fleetflow.fleet.data.MeResponse
import com.fleetflow.fleet.data.NotificationPref
import com.fleetflow.fleet.data.NotificationPrefsBody
import com.fleetflow.fleet.data.PingBatchRequest
import com.fleetflow.fleet.data.PingBatchResponse
import com.fleetflow.fleet.data.PingCount
import com.fleetflow.fleet.data.PingDto
import com.fleetflow.fleet.data.PingRequest
import com.fleetflow.fleet.data.PingResponse
import com.fleetflow.fleet.data.RegisterRequest
import com.fleetflow.fleet.data.StartTripRequest
import com.fleetflow.fleet.data.TripDetailDto
import com.fleetflow.fleet.data.TripDto
import com.fleetflow.fleet.data.TripListItemDto
import com.fleetflow.fleet.data.TripStatsDto
import com.fleetflow.fleet.data.TripsResponse
import com.fleetflow.fleet.data.UserDto
import com.fleetflow.fleet.data.VehicleDto
import com.fleetflow.fleet.data.VehiclesResponse
import java.time.Instant
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import retrofit2.HttpException
import retrofit2.Response

class FakeApiService : ApiService {

    val createdAlerts = mutableListOf<AlertDto>()

    private val user = UserDto(1,"driver@fleetflow.test","Dan Driver","DRIVER")
    private val vehicle = VehicleDto(9,"KA-01-AB","Fake Model")

    override suspend fun login(body: LoginRequest): AuthResponse = authResponse()
    override suspend fun register(body: RegisterRequest): AuthResponse = authResponse()
    override suspend fun refresh(body: Map<String,String>): AuthResponse = authResponse()
    override suspend fun me(): MeResponse = MeResponse(user)
    override suspend fun vehicles(): VehiclesResponse = VehiclesResponse(listOf(vehicle))

    override suspend fun startTrip(body: StartTripRequest): TripDto = TripDto(1,"ACTIVE",Instant.now().toString(),null,vehicle)
    override suspend fun sendPing(tripId: Int, ping: PingRequest): PingResponse = PingResponse(false)

    // Phase 10: count batch calls so a test can prove synchronous draining of a
    // large offline queue happens in a SINGLE HTTP call, not hundreds.
    var batchCalls = 0
    var lastBatchRequest: PingBatchRequest? = null
    var failNextBatch = false

    /** Trip ids whose pings the backend reports as 404 "Trip not found" (orphaned). */
    var terminal404TripIds = mutableSetOf<Int>()

    override suspend fun sendPingBatch(tripId: Int, body: PingBatchRequest): PingBatchResponse {
        if (tripId in terminal404TripIds) {
            throw HttpException(Response.error<Unit>(404, "Trip not found".toResponseBody("application/json".toMediaType())))
        }
        if (failNextBatch) {
            failNextBatch = false
            throw RuntimeException("simulated batch failure")
        }
        batchCalls++
        lastBatchRequest = body
        return PingBatchResponse(accepted = body.pings.size, duplicates = 0, failed = emptyList())
    }
    override suspend fun finishTrip(tripId: Int): TripDto = TripDto(1,"COMPLETED",Instant.now().toString(),Instant.now().toString(),vehicle)

    override suspend fun raiseAlert(body: AlertRequest) {
        createdAlerts.add(
            AlertDto(1, body.tripId, body.type,"OPEN",body.lat,body.lng,body.detail ?: "no-detail",Instant.now().toString()),
        )
    }
    override suspend fun trips(page: Int, pageSize: Int, status: String?): TripsResponse {
        val completed = TripListItemDto(
            1,
            "COMPLETED",
            Instant.now().toString(),
            Instant.now().toString(),
            vehicle,
            null,
            PingCount(3),
        )
        // Match the backend contract: active-trip recovery asks specifically
        // for ACTIVE rows and must not receive completed history as a match.
        val items = if (status == null || status == completed.status) listOf(completed) else emptyList()
        return TripsResponse(items = items, page = page, total = items.size, pages = if (items.isEmpty()) 0 else 1)
    }
override suspend fun trip(id: Int): TripDetailDto = TripDetailDto(
        id = 1,
        status = "COMPLETED",
        startedAt = Instant.now().toString(),
        finishedAt = Instant.now().toString(),
        vehicle = vehicle,
        driver = null,
        distanceKm = 5.4,
        avgSpeedKmh = 42.0,
        maxSpeedKmh = 72.0,
        durationSeconds = 460,
pings = listOf(
            PingDto(1, 12.97, 77.59, 12.0, 90.0, 5.0, Instant.now().toString()),
            PingDto(2, 12.98, 77.60,  13.5,  47.0,  3.5, Instant.now().toString()),
        ),
    )

    override suspend fun tripStats(id: Int): TripStatsDto =
        TripStatsDto(5.4,  42.0,  72.0,  460)

    override suspend fun alerts(): AlertsResponse = AlertsResponse(createdAlerts.toList())

    // Push + prefs seams (backend §7/§10): recorded for assertions, inert by default.
    val registeredTokens = mutableListOf<String>()
    val unregisteredTokens = mutableListOf<String>()
    var prefs = mutableListOf<NotificationPref>()

    override suspend fun notificationPrefs(): NotificationPrefsBody = NotificationPrefsBody(prefs.toList())
    override suspend fun updateNotificationPrefs(body: NotificationPrefsBody): NotificationPrefsBody {
        prefs = body.prefs.toMutableList()
        return body
    }
    override suspend fun registerDeviceToken(body: DeviceTokenBody): DeviceTokenResponse {
        registeredTokens.add(body.token)
        return DeviceTokenResponse(1, body.platform)
    }
    override suspend fun unregisterDeviceToken(token: String) {
        unregisteredTokens.add(token)
    }

    fun reset() {
        createdAlerts.clear()
    }

    private fun authResponse(): AuthResponse {
        return AuthResponse(user,"at-fake","rt-fake")
    }
}
