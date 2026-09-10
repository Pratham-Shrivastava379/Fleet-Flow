plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.20" apply false
    // Phase 8: KSP (Room compiler) — explicitly deferred in MVP, now justified (§3.2)
    id("com.google.devtools.ksp") version "2.0.20-1.0.25" apply false
    // Phase 8: Hilt DI — replaces ServiceLocator (§3.2)
    id("com.google.dagger.hilt.android") version "2.52" apply false
}
