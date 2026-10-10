package expo.modules.koodecallui

import android.content.Context
import android.graphics.Outline
import android.graphics.SurfaceTexture
import android.view.TextureView
import android.view.View
import android.view.ViewOutlineProvider
import com.facebook.react.bridge.ReactContext
import com.oney.WebRTCModule.KoodeVideoTracks
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import livekit.org.webrtc.EglBase
import livekit.org.webrtc.EglRenderer
import livekit.org.webrtc.GlRectDrawer
import livekit.org.webrtc.VideoTrack

/**
 * A WebRTC video view that can have rounded corners on Android.
 *
 * react-native-webrtc's RTCView draws into a SurfaceView, a separate window
 * surface that ignores view clipping, so the self-view stayed square. This
 * draws the same frames (WebRTC's EglRenderer, shared EGL context) into a
 * TextureView, which is an ordinary view and clips to a rounded outline.
 * The video fills the view ("cover").
 */
class KoodeVideoView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), TextureView.SurfaceTextureListener {

  override val shouldUseAndroidLayout = true

  private val textureView = TextureView(context)
  private val renderer = EglRenderer("KoodeVideoView")
  private var rendererReady = false
  private var track: VideoTrack? = null
  private var sinkAdded = false
  private var streamURL: String? = null
  private var radiusPx = 0f

  init {
    textureView.surfaceTextureListener = this
    addView(textureView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, radiusPx)
      }
    }
    clipToOutline = true
  }

  fun setCornerRadius(dp: Float) {
    radiusPx = dp * resources.displayMetrics.density
    invalidateOutline()
  }

  fun setMirror(mirror: Boolean) = renderer.setMirror(mirror)

  fun setStreamURL(url: String?) {
    if (url == streamURL) return
    detachSink()
    track = null
    streamURL = url
    if (url == null) return
    KoodeVideoTracks.find(context as ReactContext, url) { found ->
      post {
        if (streamURL != url) return@post
        track = found
        attachSink()
      }
    }
  }

  private fun attachSink() {
    val t = track ?: return
    if (!rendererReady || sinkAdded) return
    KoodeVideoTracks.addSink(t, renderer)
    sinkAdded = true
  }

  private fun detachSink() {
    val t = track
    if (t != null && sinkAdded) KoodeVideoTracks.removeSink(t, renderer)
    sinkAdded = false
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (!rendererReady) {
      val shared = KoodeVideoTracks.eglContext() ?: return
      renderer.init(shared, EglBase.CONFIG_PLAIN, GlRectDrawer())
      rendererReady = true
    }
    if (textureView.isAvailable) textureView.surfaceTexture?.let { startSurface(it, textureView.width, textureView.height) }
    attachSink()
  }

  override fun onDetachedFromWindow() {
    detachSink()
    if (rendererReady) {
      renderer.release()
      rendererReady = false
    }
    super.onDetachedFromWindow()
  }

  private fun startSurface(surface: SurfaceTexture, width: Int, height: Int) {
    if (!rendererReady) return
    renderer.createEglSurface(surface)
    if (width > 0 && height > 0) renderer.setLayoutAspectRatio(width.toFloat() / height)
  }

  override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) =
    startSurface(surface, width, height)

  override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
    if (width > 0 && height > 0) renderer.setLayoutAspectRatio(width.toFloat() / height)
  }

  override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
    if (rendererReady) {
      // The surface must not be used after this returns.
      val released = CountDownLatch(1)
      renderer.releaseEglSurface { released.countDown() }
      released.await(1, TimeUnit.SECONDS)
    }
    return true
  }

  override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}
}
