# Retrofit/kotlinx-serialization
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepclassmembers,allowshrinking,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}
-dontwarn org.codehaus.mojo.animal_sniffer.IgnoreJRERequirement
-dontwarn javax.annotation.**
-keep,includedescriptorclasses class com.fleetflow.fleet.data.**$$serializer { *; }
-keepclassmembers class com.fleetflow.fleet.data.** {
    *** Companion;
}
-keepclasseswithmembers class com.fleetflow.fleet.data.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Phase 13 — Sentry. Sentry SDK ships its own consumer rules;
# these cover the classes referenced from FleetApp so minified release builds
# keep the initialization path intact (see sentry-android docs).
-dontwarn io.sentry.**
-keep class io.sentry.** { *; }
-keep class io.sentry.android.core.** { *; }
-keep,includedescriptorclasses class io.sentry.protocol.** { *; }
-keep class com.fleetflow.fleet.BuildConfig { *; }
