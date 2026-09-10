package com.fleetflow.fleet.di

import com.fleetflow.fleet.BuildConfig
import com.fleetflow.fleet.data.ApiService
import com.fleetflow.fleet.data.AuthRepository
import com.fleetflow.fleet.data.TripRepository
import com.fleetflow.fleet.db.ActiveTripStateDao
import com.fleetflow.fleet.db.QueuedPingDao
import com.fleetflow.fleet.db.TokenStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

/**
 * App-facing seams (Phase 9 DI split): ApiService + AuthRepository +
 * TripRepository. Split from AppModule so Compose UI tests can swap these for
 * fakes with @UninstallModules(AppBindings::class) + a test module (§3.2).
 */
@Module
@InstallIn(SingletonComponent::class)
object AppBindings {

    @Provides @Singleton @RefreshClient
    fun refreshApi(@RefreshClient client: OkHttpClient, json: Json): ApiService =
        Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(ApiService::class.java)

    @Provides @Singleton
    fun api(client: OkHttpClient, json: Json): ApiService =
        Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(ApiService::class.java)

    @Provides @Singleton
    fun authRepository(
        api: ApiService,
        tokenStore: TokenStore,
        dao: QueuedPingDao,
    ): AuthRepository = AuthRepository(api, tokenStore, dao)

    @Provides @Singleton
    fun tripRepository(api: ApiService, dao: QueuedPingDao, activeTripDao: ActiveTripStateDao): TripRepository =
        TripRepository(api, dao, activeTripDao)
}