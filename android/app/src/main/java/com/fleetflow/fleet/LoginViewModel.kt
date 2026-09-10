package com.fleetflow.fleet

import androidx.lifecycle.ViewModel
import com.fleetflow.fleet.data.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

/** Login/register backing VM (Phase 8: Hilt-injected AuthRepository). */
@HiltViewModel
class LoginViewModel @Inject constructor(
    val authRepository: AuthRepository,
) : ViewModel()