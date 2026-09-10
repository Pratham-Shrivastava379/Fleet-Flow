package com.fleetflow.fleet.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val BrandBlue = Color(0xFF1565C0)
private val BrandAmber = Color(0xFFFFB300)

private val LightScheme = lightColorScheme(primary = BrandBlue, secondary = BrandAmber)
private val DarkScheme = darkColorScheme(primary = BrandBlue, secondary = BrandAmber)

@Composable
fun FleetFlowTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkScheme else LightScheme,
        content = content,
    )
}
