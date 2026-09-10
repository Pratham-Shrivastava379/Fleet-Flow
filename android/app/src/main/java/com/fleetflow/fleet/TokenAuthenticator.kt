package com.fleetflow.fleet

import com.fleetflow.fleet.data.ApiService
import com.fleetflow.fleet.db.TokenStore
import dagger.Lazy
import okhttp3.Authenticator
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route

/**
 * OkHttp authenticator: on 401, tries ONE refresh-token rotation to mint a new
 * access token and retries the request. Mirrors the backend's rotation rules
 * (a replayed refresh token is rejected -> force logout upstream).
 * Phase 8: takes TokenStore + a Lazy<ApiService> directly (no ServiceLocator);
 * the Lazy breaks the okHttp -> api -> okHttp constructor cycle and resolves
 * via the dedicated @RefreshClient Retrofit (no auth header loop).
 */
class TokenAuthenticator(
    private val tokenStore: TokenStore,
    private val refreshApi: Lazy<ApiService>,
) : Authenticator {
    override fun authenticate(route: Route?, response: Response): Request? {
        if (responseCount(response) >= 2) return null // already retried once
        if (response.request.header("Authorization") == null) return null

        val refresh = tokenStore.refreshToken ?: return null
        val refreshed = kotlinx.coroutines.runBlocking {
            runCatching { refreshApi.get().refresh(mapOf("refreshToken" to refresh)) }.getOrNull()
        } ?: return null // refresh failed; caller surfaces 401 (repo logs out)

        tokenStore.save(refreshed.accessToken, refreshed.refreshToken)
        return response.request.newBuilder()
            .header("Authorization", "Bearer ${refreshed.accessToken}")
            .build()
    }

    private fun responseCount(response: Response): Int {
        var count = 1
        var prior = response.priorResponse
        while (prior != null) { count++; prior = prior.priorResponse }
        return count
    }
}
