package com.oney.WebRTCModule;

import com.facebook.react.bridge.ReactContext;
import livekit.org.webrtc.EglBase;
import livekit.org.webrtc.MediaStream;
import livekit.org.webrtc.VideoSink;
import livekit.org.webrtc.VideoTrack;

/**
 * Koode: access to react-native-webrtc's streams for KoodeVideoView. The
 * lookup and its threading are package-private there, so this helper lives in
 * the same package and does exactly what WebRTCView does.
 */
public final class KoodeVideoTracks {
  public interface Callback {
    void accept(VideoTrack track);
  }

  private KoodeVideoTracks() {}

  /** Finds the stream's first video track (calls back on WebRTC's executor). */
  public static void find(ReactContext context, String streamURL, Callback callback) {
    WebRTCModule module = context.getNativeModule(WebRTCModule.class);
    if (module == null || streamURL == null) {
      callback.accept(null);
      return;
    }
    ThreadUtils.runOnExecutor(() -> {
      VideoTrack track = null;
      try {
        MediaStream stream = module.getStreamForReactTag(streamURL);
        if (stream != null && !stream.videoTracks.isEmpty()) track = stream.videoTracks.get(0);
      } catch (Throwable ignored) {
        // released meanwhile
      }
      callback.accept(track);
    });
  }

  public static void addSink(VideoTrack track, VideoSink sink) {
    ThreadUtils.runOnExecutor(() -> {
      try {
        track.addSink(sink);
      } catch (Throwable ignored) {
        // the track was released (call ended)
      }
    });
  }

  public static void removeSink(VideoTrack track, VideoSink sink) {
    ThreadUtils.runOnExecutor(() -> {
      try {
        track.removeSink(sink);
      } catch (Throwable ignored) {
        // already released
      }
    });
  }

  public static EglBase.Context eglContext() {
    return EglUtils.getRootEglBaseContext();
  }
}
