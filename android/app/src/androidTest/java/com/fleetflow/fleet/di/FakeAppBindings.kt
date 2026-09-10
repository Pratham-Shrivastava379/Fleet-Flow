package com.fleetflow.fleet.di

import com.fleetflow.fleet.data.ApiService


import com.fleetflow.fleet.data.AuthRepository
import com.fleetflow.fleet.data.TripRepository
import com.fleetflow.fleet.db.QueuedPingDao
import com.fleetflow.fleet.db.TokenStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dagger.hilt.testing.TestInstallIn
import javax.inject.Singleton

@Module
@TestInstallIn(components = [SingletonComponent::class], replaces = [AppBindings::class])
object FakeAppBindings {

    @Provides @Singleton fun fakeApi(): FakeApiService = FakeApiService()

    @Provides @Singleton @RefreshClient fun refreshApi(fake: FakeApiService): ApiService = fake

    @Provides @Singleton fun api(fake: FakeApiService): ApiService = fake

    @Provides @Singleton fun authRepository(
        api: ApiService,
        tokenStore: TokenStore,
        dao: QueuedPingDao,
    ): AuthRepository = AuthRepository(api, tokenStore, dao)

    @Provides @Singleton
    fun tripRepository(
        api: ApiService,
        dao: QueuedPingDao,
        activeTripDao: com.fleetflow.fleet.db.ActiveTripStateDao,
    ): TripRepository = TripRepository(api, dao, activeTripDao)
}