pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "FleetFlow"
include(":app")

// §6: FCM auto-activation precompiled script plugin — applies the
// google-services plugin only when android/app/google-services.json exists.
includeBuild("fcm-plugin")
