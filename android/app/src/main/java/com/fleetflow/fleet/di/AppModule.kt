package com.fleetflow.fleet.di

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.fleetflow.fleet.TokenAuthenticator
import com.fleetflow.fleet.data.ApiService
import java.security.GeneralSecurityException
import com.fleetflow.fleet.db.ActiveTripStateDao
import com.fleetflow.fleet.db.FleetDatabase
import com.fleetflow.fleet.db.QueuedPingDao
import com.fleetflow.fleet.db.TokenStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Qualifier
import javax.inject.Singleton
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor

/** Marks the unauthenticated OkHttp client used by the refresh call itself. */
@Qualifier @Retention(AnnotationRetention.BINARY) annotation class RefreshClient

/**
 * Hilt INFRA module = near-immutable wiring (context / key-storage / Room /
 * OkHttp clients). The app-facing seams (ApiService + AuthRepository +
 * TripRepository) live in AppBindings so that Hilt test modules can replace just
 * those with fakes (Phase 9 Compose UI tests) without reproducing the whole
 * graph (§3.2).
 */
@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides @Singleton
    fun appContext(@ApplicationContext context: Context): Context = context

    @Provides @Singleton
    fun json(): Json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Provides @Singleton
    fun tokenStore(@ApplicationContext context: Context): TokenStore {
        val prefs = try {
            createEncryptedPrefs(context)
        } catch (e: GeneralSecurityException) {
            // Keystore-backed blob unreadable (AEADBadTagException et al.): the
            // master key was invalidated (device backup/restore, changed screen-lock
            // credential) or the prefs file is corrupted. Fail closed to a clean
            // slate — tokens are lost (user re-logs in) instead of crashing every
            // launch. Nothing else is touched.
            context.deleteSharedPreferences("fleetflow_secure_prefs")
            createEncryptedPrefs(context)
        }
        return TokenStore(prefs)
    }

    private fun createEncryptedPrefs(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        return EncryptedSharedPreferences.create(
            context, "fleetflow_secure_prefs", masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    @Provides @Singleton
    fun database(@ApplicationContext context: Context): FleetDatabase = FleetDatabase.build(context)

    @Provides
    fun queuedPingDao(db: FleetDatabase): QueuedPingDao = db.queuedPingDao()

    @Provides
    fun activeTripStateDao(db: FleetDatabase): ActiveTripStateDao = db.activeTripStateDao()

    @Provides @Singleton @RefreshClient
    fun refreshOkHttp(): OkHttpClient =
        OkHttpClient.Builder()
            .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BODY })
            .build()

    @Provides @Singleton
    fun okHttp(
        tokenStore: TokenStore,
        @RefreshClient refreshApi: dagger.Lazy<ApiService>,
    ): OkHttpClient =
        OkHttpClient.Builder()
            .addInterceptor { chain ->
                val token = tokenStore.accessToken
                val req = if (token != null) {
                    chain.request().newBuilder().header("Authorization", "Bearer $token").build()
                } else chain.request()
                chain.proceed(req)
            }
            .authenticator(TokenAuthenticator(tokenStore, refreshApi))
            .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BODY })
            .build()
}