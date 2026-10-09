import AVFoundation
import CallKit
import Foundation
import LiveKitWebRTC
import PushKit

/// Incoming calls on iOS: PushKit wakes the app (even when it was killed) and
/// every VoIP push is reported to CallKit *before* the push handler returns.
/// Apple requires this; apps that don't are terminated and stop receiving
/// VoIP pushes. CallKit then shows the system call screen; the user's actions
/// (answer, end, mute) are forwarded to JavaScript, which runs the call.
///
/// Push payload (from the Koode server): `{ aps: {}, body: { type, callId, … } }`
///   - `type: "call"`: ring (`callerId`, `callerName`, `kind`)
///   - `type: "call-ended"`: stop ringing (answered elsewhere, cancelled, …)
final class KoodeCallManager: NSObject {
  static let shared = KoodeCallManager()

  /// Delivers events to JS; actions that happen before JS listens are queued.
  var emit: ((String, [String: Any]) -> Void)? {
    didSet { flushPending() }
  }

  private(set) var voipToken: String?
  private var registry: PKPushRegistry?
  private let provider: CXProvider
  private let callController = CXCallController()

  private struct Entry {
    let uuid: UUID
    var answered = false
  }
  private var calls: [String: Entry] = [:]  // callId → CallKit call
  private var pending: [(String, [String: Any])] = []
  /// Ends we requested ourselves (don't echo them back to JS).
  private var endingFromApp = Set<UUID>()

  /// Mirrors the server's ring timeout, so a lost "stop ringing" can't ring forever.
  private let ringTimeout: TimeInterval = 50

  private override init() {
    let config = CXProviderConfiguration()
    config.supportsVideo = true
    config.maximumCallGroups = 1
    config.maximumCallsPerCallGroup = 1
    config.supportedHandleTypes = [.generic]
    // Privacy: keep Koode calls out of the Phone app's Recents (and iCloud).
    config.includesCallsInRecents = false
    provider = CXProvider(configuration: config)
    super.init()
    provider.setDelegate(self, queue: nil)
  }

  /// Called at launch (including a background launch by PushKit).
  func start() {
    // The Simulator can't show CallKit's incoming-call UI (it ends such calls
    // at once), so don't hand out a PushKit token there: the server then falls
    // back to an ordinary "Incoming call" notification.
    #if targetEnvironment(simulator)
      return
    #endif
    guard registry == nil else { return }
    let r = PKPushRegistry(queue: .main)
    r.delegate = self
    r.desiredPushTypes = [.voIP]
    registry = r
  }

  // MARK: Reporting

  /// Reports a ringing call to CallKit. `completion` runs once CallKit has it.
  func reportIncoming(callId: String, callerId: String, callerName: String, video: Bool, completion: @escaping () -> Void) {
    if calls[callId] != nil {
      completion()  // duplicate push for a call we already show
      return
    }
    let uuid = UUID()
    calls[callId] = Entry(uuid: uuid)
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: callerId)
    update.localizedCallerName = callerName
    update.hasVideo = video
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
      NSLog("[KoodeCalls] reported incoming: %@", error?.localizedDescription ?? "ok")
      guard let self else { return completion() }
      if let error {
        // Do Not Disturb, Focus filters or a blocked handle: not shown.
        self.calls[callId] = nil
        self.send("ignored", ["callId": callId, "reason": error.localizedDescription])
      } else {
        self.send("reported", ["callId": callId])
        DispatchQueue.main.asyncAfter(deadline: .now() + self.ringTimeout) { [weak self] in
          guard let self, let e = self.calls[callId], !e.answered else { return }
          self.provider.reportCall(with: e.uuid, endedAt: Date(), reason: .unanswered)
          self.calls[callId] = nil
          self.send("end", ["callId": callId, "answered": false])
        }
      }
      completion()
    }
  }

  /// Ends a call CallKit is showing. `local`: the user hung up in the app.
  func end(callId: String, reason: String) {
    guard let e = calls[callId] else { return }
    if reason == "local" {
      endingFromApp.insert(e.uuid)
      callController.request(CXTransaction(action: CXEndCallAction(call: e.uuid))) { _ in }
    } else {
      let r: CXCallEndedReason = switch reason {
      case "answeredElsewhere": .answeredElsewhere
      case "declinedElsewhere": .declinedElsewhere
      case "unanswered": .unanswered
      case "failed": .failed
      default: .remoteEnded
      }
      provider.reportCall(with: e.uuid, endedAt: Date(), reason: r)
    }
    calls[callId] = nil
  }

  /// Keeps the system call UI's mute button in sync with the app.
  func setMuted(callId: String, muted: Bool) {
    guard let e = calls[callId] else { return }
    callController.request(CXTransaction(action: CXSetMutedCallAction(call: e.uuid, muted: muted))) { _ in }
  }

  func connected(callId: String) {
    guard let e = calls[callId] else { return }
    let update = CXCallUpdate()
    update.supportsHolding = false
    provider.reportCall(with: e.uuid, updated: update)
  }

  var activeCallIds: [String] { Array(calls.keys) }

  #if DEBUG
    /// Development: answers through CallKit exactly as tapping Answer does.
    func simulateAnswer(callId: String) {
      guard let e = calls[callId] else { return }
      callController.request(CXTransaction(action: CXAnswerCallAction(call: e.uuid))) { _ in }
    }
  #endif

  /// Same path as a real VoIP push (development builds use it on the Simulator,
  /// which has no PushKit).
  func handlePush(_ payload: [AnyHashable: Any], completion: @escaping () -> Void) {
    let body = payload["body"] as? [String: Any] ?? [:]
    let type = body["type"] as? String
    let callId = body["callId"] as? String ?? UUID().uuidString

    if type == "call" {
      reportIncoming(
        callId: callId,
        callerId: body["callerId"] as? String ?? "unknown",
        callerName: body["callerName"] as? String ?? "Koode",
        video: (body["kind"] as? String) == "video",
        completion: completion
      )
      return
    }
    if type == "call-ended", calls[callId] != nil {
      end(callId: callId, reason: "remoteEnded")
      send("end", ["callId": callId, "answered": false])
      return completion()
    }
    // Unknown or stale push: iOS still requires a reported call, so report one
    // and end it immediately.
    let uuid = UUID()
    let update = CXCallUpdate()
    update.localizedCallerName = "Koode"
    provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] _ in
      self?.provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
      completion()
    }
  }

  // MARK: Events

  private func send(_ name: String, _ body: [String: Any]) {
    if let emit { emit(name, body) } else { pending.append((name, body)) }
  }

  private func flushPending() {
    guard let emit else { return }
    let queued = pending
    pending.removeAll()
    queued.forEach { emit($0.0, $0.1) }
  }

  private func callId(for uuid: UUID) -> String? {
    calls.first { $0.value.uuid == uuid }?.key
  }
}

// MARK: - PushKit

extension KoodeCallManager: PKPushRegistryDelegate {
  func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    let token = credentials.token.map { String(format: "%02x", $0) }.joined()
    voipToken = token
    send("voipToken", ["token": token])
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    voipToken = nil
    send("voipToken", ["token": NSNull()])
  }

  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    handlePush(payload.dictionaryPayload, completion: completion)
  }
}

// MARK: - CallKit

extension KoodeCallManager: CXProviderDelegate {
  func providerDidReset(_ provider: CXProvider) {
    NSLog("[KoodeCalls] provider reset (%d calls)", calls.count)
    for id in calls.keys { send("end", ["callId": id, "answered": calls[id]?.answered ?? false]) }
    calls.removeAll()
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let id = callId(for: action.callUUID) else { return action.fail() }
    calls[id]?.answered = true
    send("answer", ["callId": id])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    NSLog("[KoodeCalls] end action (fromApp=%d)", endingFromApp.contains(action.callUUID) ? 1 : 0)
    if endingFromApp.remove(action.callUUID) != nil { return action.fulfill() }
    if let id = callId(for: action.callUUID) {
      send("end", ["callId": id, "answered": calls[id]?.answered ?? false])
      calls[id] = nil
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    if let id = callId(for: action.callUUID) { send("mute", ["callId": id, "muted": action.isMuted]) }
    action.fulfill()
  }

  // CallKit activates the audio session (with elevated priority) once the call
  // is answered; WebRTC must start and stop its audio unit with it.
  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    LKRTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    LKRTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
  }
}
