import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    // kotlinx.serialization: generates serializers for @Serializable DTOs, which the
    // Retrofit converter (Json.asConverterFactory) resolves at request time. Without
    // this plugin Retrofit throws "Unable to create @Body converter ..." on every call.
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
    id("com.google.dagger.hilt.android")
    // §6: applies com.google.gms.google-services ONLY when google-services.json
    // exists (see fcm-activate.gradle.kts) — FCM activates automatically when
    // Firebase credentials are supplied, builds keep working when they are not.
    id("fcm-activate")
}

// Keys come from local.properties (never committed):
//   GOOGLE_MAPS_KEY=your_key
//   SENTRY_DSN=https://...@ingest.us.sentry.io/...   (Phase 13; blank = disabled)
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// Phase 14: release signing keys come from the environment —
// CI materializes the keystore from secrets and sets KEYSTORE_PATH /
// KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD. The key is NEVER committed.
// Absent env = unsigned release build (local dev; stub-until-configured).
val envOrNull: (String) -> String? = { name -> System.getenv(name)?.takeIf { it.isNotBlank() } }
val keystorePath = envOrNull("KEYSTORE_PATH")
val keystorePassword = envOrNull("KEYSTORE_PASSWORD")
val keyAlias = envOrNull("KEY_ALIAS")
val keyPassword = envOrNull("KEY_PASSWORD")
val releaseSigningConfigured =
    keystorePath != null && keystorePassword != null && keyAlias != null && keyPassword != null

android {
    namespace = "com.fleetflow.fleet"
    compileSdk = 35

    // Phase 14: only created when the CI signing env vars are present. Locals are
    // captured under distinct names — inside the SigningConfig receiver, plain
    // `keyAlias` refers to the receiver's own (null) property, not the outer val.
    if (releaseSigningConfigured) {
        val cfgPath = keystorePath!!
        val cfgStorePassword = keystorePassword!!
        val cfgAlias = keyAlias!!
        val cfgKeyPassword = keyPassword!!
        signingConfigs.create("release") {
            storeFile = file(cfgPath)
            storePassword = cfgStorePassword
            keyAlias = cfgAlias
            keyPassword = cfgKeyPassword
        }
    }

    defaultConfig {
        applicationId = "com.fleetflow.fleet"
        minSdk = 26
        targetSdk = 35
        // Phase 14 (§13.4): the release workflow derives version from the git tag
        // (VERSION_NAME e.g. 1.2.0) and bumps VERSION_CODE from CI; local builds
        // keep the defaults.
        versionCode = (System.getenv("VERSION_CODE")?.takeIf { it.isNotBlank() } ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME")?.takeIf { it.isNotBlank() } ?: "1.0.0"
        manifestPlaceholders["googleMapsKey"] = localProps.getProperty("GOOGLE_MAPS_KEY") ?: ""
        // Phase 13 (§11.4): Sentry DSN injected at build time from local.properties
        // (release builds: inject via CI secret instead, same pattern as the maps key).
        // Blank DSN = Sentry not initialized on device (stub-until-configured).
        // Runtime init happens only in FleetApp.onCreate; the SDK's auto-init
        // ContentProvider is disabled in the manifest (io.sentry.auto-init=false)
        // so a missing DSN can never crash startup.
        buildConfigField("String", "SENTRY_DSN", "\"${localProps.getProperty("SENTRY_DSN") ?: ""}\"")
        // GOOGLE_MAPS_KEY: read ONLY from android/local.properties
        // (`GOOGLE_MAPS_KEY=`), never committed, never printed. The manifest
        // placeholder uses the same property; this build-config field lets the
        // runtime show provider-neutral fallback when the key is absent (CI/dev).
        buildConfigField("String", "GOOGLE_MAPS_KEY", "\"${localProps.getProperty("GOOGLE_MAPS_KEY") ?: ""}\"")
        // Phase 14 (§13.4): release builds need a reachable API base URL. CI writes
        // local.properties (API_BASE_URL) from secrets; blank = stub until a real
        // deployment URL exists (debug builds override to 10.0.2.2 below).
        buildConfigField(
            "String",
            "API_BASE_URL",
            "\"${localProps.getProperty("API_BASE_URL") ?: ""}\"",
        )
        testInstrumentationRunner = "com.fleetflow.fleet.HiltTestRunner"
    }

    buildTypes {
        debug {
            // Emulator-style loopback base URL; with `adb reverse tcp:3000 tcp:3000`
            // this reaches the PC-hosted API over USB from a PHYSICAL device too
            // (fallback when AP isolation blocks LAN access to 192.168.1.42).
            buildConfigField("String", "API_BASE_URL", "\"http://127.0.0.1:3000/\"")
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Phase 14 (§13.4): signed when CI supplies the keystore env vars; unsigned
            // otherwise so local `assembleRelease` still works. CI never sees the key.
            signingConfig = if (releaseSigningConfigured) signingConfigs.getByName("release") else null
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

// Keep Room's schema history in source control so migrations can be reviewed
// and tested instead of relying on an opaque generated database shape.
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.4")
    implementation("androidx.lifecycle:lifecycle-service:2.8.4")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation("androidx.navigation:navigation-compose:2.8.0")

    // Networking
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-kotlinx-serialization:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Local persistence (offline queue) — Phase 8: Room replaces SQLiteOpenHelper (§3.6)
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // Phase 8: Hilt DI (§3.2) — mirrors the old ServiceLocator 1:1
    implementation("com.google.dagger:hilt-android:2.52")
    ksp("com.google.dagger:hilt-compiler:2.52")
    implementation("androidx.hilt:hilt-navigation-compose:1.2.0")
    implementation("androidx.hilt:hilt-work:1.2.0")
    ksp("androidx.hilt:hilt-compiler:1.2.0")

    // Location & background work
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // Maps
    implementation("com.google.android.gms:play-services-maps:20.0.0")
    implementation("com.google.maps.android:maps-compose:6.4.1")

    // Security (EncryptedSharedPreferences for JWT storage)
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Push notifications transport (FCM) — add google-services.json + plugin to enable
    implementation("com.google.firebase:firebase-messaging:24.0.0")

    // Phase 13 (§11.4): Sentry crash/ANR/error reporting. Runtime init is env-
    // gated in FleetApp (SENTRY_DSN build config field from local.properties).
    implementation("io.sentry:sentry-android:7.22.6")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")

    // Phase 8: Room DAO instrumentation tests
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.room:room-testing:2.6.1")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    kspAndroidTest("com.google.dagger:hilt-compiler:2.52")

    // Phase 9: Compose UI critical-path tests
    androidTestImplementation(platform(composeBom))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("com.google.dagger:hilt-android-testing:2.52")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    debugImplementation(platform(composeBom))
}
