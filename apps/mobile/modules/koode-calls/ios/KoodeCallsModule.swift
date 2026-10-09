import ExpoModulesCore

/// JS bridge to KoodeCallManager. The manager's state is only touched on the
/// main queue (CallKit and PushKit call it there too).
public class KoodeCallsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KoodeCalls")

    Events("voipToken", "reported", "ignored", "answer", "end", "mute")

    /// JS calls this once its listeners are attached. Actions that happened
    /// earlier (e.g. answering from the lock screen during a cold start) were
    /// queued by the manager and are delivered now.
    Function("startListening") {
      DispatchQueue.main.async {
        KoodeCallManager.shared.emit = { [weak self] name, body in
          self?.sendEvent(name, body)
        }
      }
    }

    OnDestroy {
      DispatchQueue.main.async { KoodeCallManager.shared.emit = nil }
    }

    AsyncFunction("voipToken") { () -> String? in
      KoodeCallManager.shared.voipToken
    }.runOnQueue(.main)

    AsyncFunction("activeCallIds") { () -> [String] in
      KoodeCallManager.shared.activeCallIds
    }.runOnQueue(.main)

    /// reason: "local" (hung up in the app), "remoteEnded", "answeredElsewhere",
    /// "declinedElsewhere", "unanswered" or "failed".
    Function("endCall") { (callId: String, reason: String) in
      DispatchQueue.main.async { KoodeCallManager.shared.end(callId: callId, reason: reason) }
    }

    Function("setMuted") { (callId: String, muted: Bool) in
      DispatchQueue.main.async { KoodeCallManager.shared.setMuted(callId: callId, muted: muted) }
    }

    Function("reportConnected") { (callId: String) in
      DispatchQueue.main.async { KoodeCallManager.shared.connected(callId: callId) }
    }

    /// Development only: feeds a payload through the real VoIP push handler
    /// (the Simulator has no PushKit).
    AsyncFunction("simulateVoipPush") { (payload: [String: Any], promise: Promise) in
      #if DEBUG
        KoodeCallManager.shared.handlePush(payload) { promise.resolve(nil) }
      #else
        promise.reject("ERR_UNAVAILABLE", "Only available in development builds")
      #endif
    }.runOnQueue(.main)

    /// Development only: answers through CallKit as tapping Answer does.
    Function("simulateAnswer") { (callId: String) in
      #if DEBUG
        DispatchQueue.main.async { KoodeCallManager.shared.simulateAnswer(callId: callId) }
      #endif
    }
  }
}
