package com.fleetflow.fleet

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import com.fleetflow.fleet.push.PushTokenSync
import com.fleetflow.fleet.ui.theme.FleetFlowTheme
import androidx.hilt.navigation.compose.hiltViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(onAuthed: (isDriver: Boolean) -> Unit) {
    val vm: LoginViewModel = hiltViewModel()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var registerMode by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var checkingSession by remember { mutableStateOf(vm.authRepository.isLoggedIn) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = remember { CoroutineScope(Dispatchers.Main.immediate) }
    val appContext = LocalContext.current.applicationContext

    LaunchedEffect(Unit) {
        if (vm.authRepository.isLoggedIn) {
            vm.authRepository.restoreSession()
                .onSuccess {
                    onAuthed(vm.authRepository.isDriver)
                    scope.launch { PushTokenSync.uploadCurrentToken(appContext) }
                }
                .onFailure {
                    vm.authRepository.logout()
                    checkingSession = false
                }
        }
    }

    FleetFlowTheme {
        Column(
            Modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("FleetFlow", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(bottom = 24.dp))
            if (checkingSession) {
                CircularProgressIndicator()
                Text("Restoring secure session…", modifier = Modifier.padding(top = 12.dp))
                return@Column
            }
            if (registerMode) {
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
            }
            OutlinedTextField(
                email,
                { email = it },
                label = { Text("Email") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                password,
                { password = it },
                label = { Text("Password") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (error != null) Card { Text("⚠ $error", Modifier.padding(8.dp)) }
            Button(
                onClick = {
                    busy = true; error = null
                    scope.launch {
                        val result = if (registerMode) {
                            vm.authRepository.register(email.trim(), password, name.trim())
                        } else {
                            vm.authRepository.login(email.trim(), password)
                        }
                        busy = false
                        result.onFailure { error = it.message ?: "Login failed" }
                        result.onSuccess {
                            // Role captured server-side at login/register; managers and
                            // admins land on the fleet view, not the driver tracking
                // flow (driver-flow prevention).
                            onAuthed(vm.authRepository.isDriver)
                            // FCM push registration (§10): upload this device's token
                            // once authed so fleet alerts can reach it. Fail-open —
                            // no-op when FCM is unconfigured (no google-services.json).
                            scope.launch { PushTokenSync.uploadCurrentToken(appContext) }
                        }
                    }
                },
                enabled = !busy && email.isNotBlank() && password.length >= 8 && (!registerMode || name.length >= 2),
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            ) {
                if (busy) CircularProgressIndicator(Modifier.padding(4.dp)) else Text(if (registerMode) "Register" else "Sign in")
            }
            TextButton(onClick = { registerMode = !registerMode; error = null }) {
                Text(if (registerMode) "Have an account? Sign in" else "New driver? Create account")
            }
        }
    }
}
