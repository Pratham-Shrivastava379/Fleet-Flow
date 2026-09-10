import org.gradle.api.Plugin
import org.gradle.api.Project
import java.io.File

/**
 * §6 (push notification readiness): FCM auto-activation gate.
 *
 * Applies `com.google.gms.google-services` ONLY when
 * `android/app/google-services.json` exists:
 *  - fresh clone / CI (no Firebase credentials): the plugin is NOT applied and
 *    the build is byte-identical to a no-Firebase build — the FCM runtime code
 *    stays dormant-safe (no FirebaseApp; every Firebase call no-ops inside
 *    runCatching in PushTokenSync / FcmMessagingService).
 *  - a developer drops a real google-services.json into android/app/: the
 *    plugin activates automatically on the next build, with no build-file edit.
 */
class FcmActivatePlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val marker = File(project.projectDir, "google-services.json")
        if (marker.exists()) {
            project.pluginManager.apply("com.google.gms.google-services")
            project.logger.lifecycle("FCM: google-services.json found — google-services plugin applied (push notifications ACTIVE).")
        } else {
            project.logger.lifecycle("FCM: no google-services.json — building WITHOUT the google-services plugin (push notifications dormant; the app builds and runs normally).")
        }
    }
}
