package com.fleetflow.fleet.data

import com.fleetflow.fleet.db.QueuedPingDao
import com.fleetflow.fleet.db.TokenStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AuthRepository(private val api: ApiService, private val tokenStore: TokenStore, private val queuedPingDao: QueuedPingDao) {

    suspend fun login(email: String, password: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val res = api.login(LoginRequest(email, password))
            tokenStore.save(res.accessToken, res.refreshToken)
            tokenStore.role = res.user.role
        }
    }

    suspend fun register(email: String, password: String, name: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val res = api.register(RegisterRequest(email, password, name))
                tokenStore.save(res.accessToken, res.refreshToken)
                tokenStore.role = res.user.role
            }
        }

    /**
     * Validates an encrypted on-device session against the backend. Retrofit's
     * authenticator refreshes an expired access token when the refresh token is
     * still valid, so returning users can resume without seeing the login form.
     */
    suspend fun restoreSession(): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val user = api.me().user
            tokenStore.role = user.role
        }
    }

    /**
 * True only for driver accounts: manager and
     * admin accounts are fleet-view users — the driver trip flows (start/finish
     * trip, SOS) are not for them. Captured at login/register; advisory only —
     * the backend remains the enforcement authority.
     */
    val isDriver: Boolean get() = tokenStore.role == "DRIVER"

    fun logout() {
        // Phase 8: clear the offline ping queue on logout (Room, Hilt-injected DAO)
        kotlinx.coroutines.runBlocking { kotlinx.coroutines.withContext(Dispatchers.IO) { queuedPingDao.clearAll() } }
        tokenStore.clear()
    }

    val isLoggedIn: Boolean get() = tokenStore.isLoggedIn
}
