plugins {
    `kotlin-dsl`
}

group = "com.fleetflow.fleet.build"

repositories {
    google()
    mavenCentral()
}

dependencies {
    // §6: compile against the google-services plugin so the gate script can
    // apply it by id when google-services.json is present.
    implementation("com.google.gms:google-services:4.4.2")
}

gradlePlugin {
    plugins {
        create("fcmActivate") {
            id = "fcm-activate"
            implementationClass = "FcmActivatePlugin"
        }
    }
}
