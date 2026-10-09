import ExpoModulesCore

/// Registers for VoIP pushes at launch. When PushKit launches the app in the
/// background for an incoming call, this runs before JavaScript exists, so the
/// call can be reported to CallKit in time.
public class KoodeCallsAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    KoodeCallManager.shared.start()
    return true
  }
}
