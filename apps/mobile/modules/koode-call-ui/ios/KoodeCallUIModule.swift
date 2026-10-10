import ExpoModulesCore
import UIKit

/// In-call screen behaviour. iOS picture-in-picture comes from LiveKit's
/// VideoTrack (AVKit), so only the proximity sensor lives here.
public class KoodeCallUIModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KoodeCallUI")

    /// Screen off when the phone is held to the ear (voice calls on the earpiece).
    AsyncFunction("setProximity") { (enabled: Bool) in
      UIDevice.current.isProximityMonitoringEnabled = enabled
    }.runOnQueue(.main)

    /// Android only; picture-in-picture on iOS is per video view.
    AsyncFunction("setPictureInPicture") { (_: Bool, _: Int, _: Int) in }
    AsyncFunction("enterPictureInPicture") {}
    /// Android only: iOS keeps calls running through the audio background mode.
    AsyncFunction("startCall") { (_: Bool, _: String) in }
    AsyncFunction("endCall") {}
  }
}
