package expo.modules.koodecallui

import android.app.PictureInPictureParams
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.util.Rational
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * In-call screen behaviour on Android: the proximity sensor (screen off at the
 * ear), picture-in-picture for video calls, and KoodeVideoView (rounded video).
 */
class KoodeCallUIModule : Module() {
  private var pipEnabled = false
  private var pipAspect = Rational(9, 16)
  private var proximity: PowerManager.WakeLock? = null

  override fun definition() = ModuleDefinition {
    Name("KoodeCallUI")

    AsyncFunction("setProximity") { enabled: Boolean -> setProximity(enabled) }.runOnQueue(Queues.MAIN)

    /** Video call on screen: leaving the app shrinks it into a floating window. */
    AsyncFunction("setPictureInPicture") { enabled: Boolean, width: Int, height: Int ->
      setPictureInPicture(enabled, width, height)
    }.runOnQueue(Queues.MAIN)

    // Android 8–11 has no auto-enter: enter when the user leaves (Home, Recents).
    OnUserLeavesActivity {
      if (pipEnabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        try {
          appContext.currentActivity?.enterPictureInPictureMode(pipParams())
        } catch (_: IllegalStateException) {
          // the activity doesn't support picture-in-picture
        }
      }
    }

    OnDestroy { setProximity(false) }

    View(KoodeVideoView::class) {
      Prop("streamURL") { view: KoodeVideoView, url: String? -> view.setStreamURL(url) }
      Prop("mirror") { view: KoodeVideoView, mirror: Boolean -> view.setMirror(mirror) }
      Prop("cornerRadius") { view: KoodeVideoView, radius: Double -> view.setCornerRadius(radius.toFloat()) }
    }
  }

  private fun setProximity(enabled: Boolean) {
    val context = appContext.reactContext ?: return
    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (enabled) {
      if (proximity != null || !power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
      proximity = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "koode:proximity").apply {
        setReferenceCounted(false)
        acquire(4 * 60 * 60 * 1000L) // a long call at most; released when it ends
      }
    } else {
      proximity?.let { if (it.isHeld) it.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) }
      proximity = null
    }
  }

  private fun pipParams(): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder().setAspectRatio(pipAspect)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(pipEnabled).setSeamlessResizeEnabled(true)
    }
    return builder.build()
  }

  private fun setPictureInPicture(enabled: Boolean, width: Int, height: Int) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    pipEnabled = enabled
    if (width > 0 && height > 0) {
      // Android accepts aspect ratios between 1:2.39 and 2.39:1.
      val ratio = (width.toFloat() / height).coerceIn(1 / 2.39f, 2.39f)
      pipAspect = Rational((ratio * 1000).toInt(), 1000)
    }
    val activity = appContext.currentActivity ?: return
    try {
      activity.setPictureInPictureParams(pipParams())
    } catch (_: IllegalStateException) {
      return
    }
    // The call ended while floating: close the window rather than shrink the app.
    if (!enabled && activity.isInPictureInPictureMode) activity.moveTaskToBack(false)
  }
}
