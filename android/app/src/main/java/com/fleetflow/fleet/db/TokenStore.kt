package com.fleetflow.fleet.db

import android.content.SharedPreferences

/**
 * Stores JWT pair + the account's role in EncryptedSharedPreferences
 * (Android Keystore-backed). The role drives client-side driver-flow gating
 * Manager/admin accounts must not reach the
 * driver trip flows. It is advisory only — the backend remains the authority.
 */
class TokenStore(private val prefs: SharedPreferences) {
    var accessToken: String?
        get() = prefs.getString(KEY_ACCESS, null)
        private set(_) {}
    var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH, null)
        private set(_) {}

    /** Role captured at login/register ("ADMIN" | "FLEET_MANAGER" | "DRIVER"). */
    var role: String?
        get() = prefs.getString(KEY_ROLE, null)
        set(value) = prefs.edit().putString(KEY_ROLE, value).apply()

    fun save(access: String, refresh: String) {
        prefs.edit().putString(KEY_ACCESS, access).putString(KEY_REFRESH, refresh).apply()
    }

    fun clear() = prefs.edit().clear().apply()

    val isLoggedIn: Boolean get() = accessToken != null

    private companion object {
        const val KEY_ACCESS = "access_token"
        const val KEY_REFRESH = "refresh_token"
        const val KEY_ROLE = "account_role"
    }
}
