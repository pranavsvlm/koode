package expo.modules.koodecallui

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * A foreground service while a call is on, with an ongoing "call in progress"
 * notification. Without it Android cuts a background app's microphone (and
 * camera), and may stop the process; with it, a call keeps going while you use
 * another app or the call floats in picture-in-picture.
 */
class KoodeCallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val video = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Koode"
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Ongoing calls", NotificationManager.IMPORTANCE_LOW),
      )
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
    }
    val tap = open?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL)
      else @Suppress("DEPRECATION") Notification.Builder(this)
    val notification = builder
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(title)
      .setContentText(if (video) "Video call in progress · tap to return" else "Call in progress · tap to return")
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_CALL)
      .setContentIntent(tap)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // The camera type needs the camera permission (granted when video started).
      val camera = video &&
        checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
      val type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        (if (camera) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0)
      try {
        startForeground(NOTIFICATION_ID, notification, type)
      } catch (_: Exception) {
        // e.g. a permission was withdrawn: keep the call without the service
        stopSelf()
      }
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_NOT_STICKY
  }

  companion object {
    const val EXTRA_VIDEO = "video"
    const val EXTRA_TITLE = "title"
    private const val CHANNEL = "koode-ongoing-call"
    private const val NOTIFICATION_ID = 4711
  }
}
