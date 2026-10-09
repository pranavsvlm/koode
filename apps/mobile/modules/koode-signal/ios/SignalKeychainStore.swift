import Foundation
import LibSignalClient
import Security

/// libsignal's protocol stores, persisted in the Keychain: this device's
/// identity and prekeys, the identities of devices it has talked to, and the
/// Double Ratchet sessions. Items are readable after the first unlock (an
/// incoming call or push may wake the app while locked), only on this device,
/// and never synced or backed up.
final class SignalKeychainStore: IdentityKeyStore, PreKeyStore, SignedPreKeyStore, KyberPreKeyStore,
  SessionStore
{
  private let service = "koode.signal"

  // MARK: Keychain

  private func query(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }

  func get(_ key: String) -> Data? {
    var q = query(key)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
  }

  func set(_ key: String, _ data: Data) throws {
    SecItemDelete(query(key) as CFDictionary)
    var q = query(key)
    q[kSecValueData as String] = data
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(q as CFDictionary, nil)
    if status != errSecSuccess {
      throw SignalError.invalidState("Keychain write failed (\(status))")
    }
  }

  func remove(_ key: String) {
    SecItemDelete(query(key) as CFDictionary)
  }

  /// Everything this store ever wrote (sign-out).
  func wipe() {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    SecItemDelete(q as CFDictionary)
  }

  private func name(_ a: ProtocolAddress) -> String { "\(a.name).\(a.deviceId)" }

  // MARK: Identity

  func identityKeyPair(context: StoreContext) throws -> IdentityKeyPair {
    guard let data = get("identity") else { throw SignalError.invalidState("No identity key") }
    return try IdentityKeyPair(bytes: data)
  }

  func localRegistrationId(context: StoreContext) throws -> UInt32 {
    guard let data = get("registration"), data.count == 4 else {
      throw SignalError.invalidState("No registration id")
    }
    return data.withUnsafeBytes { $0.load(as: UInt32.self) }
  }

  func saveIdentity(_ identity: IdentityKey, for address: ProtocolAddress, context: StoreContext) throws
    -> IdentityChange
  {
    let key = "rid.\(name(address))"
    let old = get(key)
    try set(key, identity.serialize())
    return old == nil || old == identity.serialize() ? .newOrUnchanged : .replacedExisting
  }

  /// Trust on first use. A device's identity never legitimately changes (a new
  /// device is a new address), so a different key is refused.
  func isTrustedIdentity(
    _ identity: IdentityKey, for address: ProtocolAddress, direction: Direction, context: StoreContext
  ) throws -> Bool {
    guard let known = get("rid.\(name(address))") else { return true }
    return known == identity.serialize()
  }

  func identity(for address: ProtocolAddress, context: StoreContext) throws -> IdentityKey? {
    try get("rid.\(name(address))").map { try IdentityKey(bytes: $0) }
  }

  func removeIdentity(for address: ProtocolAddress) {
    remove("rid.\(name(address))")
  }

  // MARK: Prekeys

  func loadPreKey(id: UInt32, context: StoreContext) throws -> PreKeyRecord {
    guard let data = get("pk.\(id)") else { throw SignalError.invalidKeyIdentifier("prekey \(id)") }
    return try PreKeyRecord(bytes: data)
  }

  func storePreKey(_ record: PreKeyRecord, id: UInt32, context: StoreContext) throws {
    try set("pk.\(id)", record.serialize())
  }

  func removePreKey(id: UInt32, context: StoreContext) throws {
    remove("pk.\(id)")
  }

  func loadSignedPreKey(id: UInt32, context: StoreContext) throws -> SignedPreKeyRecord {
    guard let data = get("spk.\(id)") else { throw SignalError.invalidKeyIdentifier("signed prekey \(id)") }
    return try SignedPreKeyRecord(bytes: data)
  }

  func storeSignedPreKey(_ record: SignedPreKeyRecord, id: UInt32, context: StoreContext) throws {
    try set("spk.\(id)", record.serialize())
  }

  func loadKyberPreKey(id: UInt32, context: StoreContext) throws -> KyberPreKeyRecord {
    guard let data = get("kpk.\(id)") else { throw SignalError.invalidKeyIdentifier("kyber prekey \(id)") }
    return try KyberPreKeyRecord(bytes: data)
  }

  func storeKyberPreKey(_ record: KyberPreKeyRecord, id: UInt32, context: StoreContext) throws {
    try set("kpk.\(id)", record.serialize())
  }

  func markLastResort(_ id: UInt32) throws {
    try set("kpk-last-resort.\(id)", Data([1]))
  }

  /// One-time Kyber prekeys are deleted after use. The last-resort key stays,
  /// but each (key, signed prekey, base key) combination is accepted only once,
  /// as in libsignal's reference store.
  func markKyberPreKeyUsed(id: UInt32, signedPreKeyId: UInt32, baseKey: PublicKey, context: StoreContext)
    throws
  {
    guard get("kpk-last-resort.\(id)") != nil else {
      remove("kpk.\(id)")
      return
    }
    let seenKey = "kpk-seen.\(id).\(signedPreKeyId)"
    var seen = get(seenKey) ?? Data()
    let base = baseKey.serialize()
    var offset = 0
    while offset + base.count <= seen.count {
      if seen.subdata(in: offset..<offset + base.count) == base {
        throw SignalError.invalidMessage("reused base key")
      }
      offset += base.count
    }
    seen.append(base)
    try set(seenKey, seen)
  }

  // MARK: Sessions

  func loadSession(for address: ProtocolAddress, context: StoreContext) throws -> SessionRecord? {
    try get("session.\(name(address))").map { try SessionRecord(bytes: $0) }
  }

  func loadExistingSessions(for addresses: [ProtocolAddress], context: StoreContext) throws -> [SessionRecord] {
    try addresses.map { address in
      guard let s = try loadSession(for: address, context: context) else {
        throw SignalError.sessionNotFound("\(address)")
      }
      return s
    }
  }

  func storeSession(_ record: SessionRecord, for address: ProtocolAddress, context: StoreContext) throws {
    try set("session.\(name(address))", record.serialize())
  }

  func removeSession(for address: ProtocolAddress) {
    remove("session.\(name(address))")
  }
}
