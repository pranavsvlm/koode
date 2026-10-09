import CryptoKit
import ExpoModulesCore
import Foundation
import LibSignalClient

/// End-to-end encryption with Signal's libsignal. Binary values cross the
/// bridge as base64 strings; message plaintext as UTF-8 text. Protocol calls
/// run on one serial queue, because the stores aren't safe to use
/// concurrently; file encryption doesn't touch them and runs alongside.
public class KoodeSignalModule: Module {
  private let store = SignalKeychainStore()
  private let queue = DispatchQueue(label: "koode.signal")
  /// Files are independent of the protocol stores (and can be large).
  private let files = DispatchQueue(label: "koode.signal.files", attributes: .concurrent)
  private let context = NullContext()

  public func definition() -> ModuleDefinition {
    Name("KoodeSignal")

    /// Creates this device's identity key and registration id once.
    AsyncFunction("ensureIdentity") { () -> [String: Any] in
      try self.serial {
        var created = false
        if self.store.get("identity") == nil {
          try self.store.set("identity", IdentityKeyPair.generate().serialize())
          var id = UInt32.random(in: 1...16380)
          try self.store.set("registration", Data(bytes: &id, count: 4))
          created = true
        }
        let identity = try self.store.identityKeyPair(context: self.context)
        return [
          "identityKey": identity.identityKey.serialize().base64EncodedString(),
          "registrationId": try self.store.localRegistrationId(context: self.context),
          "created": created,
        ]
      }
    }

    AsyncFunction("generatePreKeys") { (startId: Int, count: Int) -> [[String: Any]] in
      try self.serial {
        try (0..<count).map { i in
          let id = UInt32(startId + i)
          let key = PrivateKey.generate()
          let record = try PreKeyRecord(id: id, privateKey: key)
          try self.store.storePreKey(record, id: id, context: self.context)
          return ["keyId": id, "publicKey": key.publicKey.serialize().base64EncodedString()]
        }
      }
    }

    AsyncFunction("generateSignedPreKey") { (id: Int) -> [String: Any] in
      try self.serial {
        let identity = try self.store.identityKeyPair(context: self.context)
        let key = PrivateKey.generate()
        let publicKey = key.publicKey.serialize()
        let signature = identity.privateKey.generateSignature(message: publicKey)
        let record = try SignedPreKeyRecord(
          id: UInt32(id), timestamp: self.nowMillis(), privateKey: key, signature: signature)
        try self.store.storeSignedPreKey(record, id: UInt32(id), context: self.context)
        return [
          "keyId": id,
          "publicKey": publicKey.base64EncodedString(),
          "signature": signature.base64EncodedString(),
        ]
      }
    }

    /// One-time Kyber prekeys, or (lastResort) the single long-lived one.
    AsyncFunction("generateKyberPreKeys") { (startId: Int, count: Int, lastResort: Bool) -> [[String: Any]] in
      try self.serial {
        let identity = try self.store.identityKeyPair(context: self.context)
        return try (0..<count).map { i in
          let id = UInt32(startId + i)
          let pair = KEMKeyPair.generate()
          let publicKey = pair.publicKey.serialize()
          let signature = identity.privateKey.generateSignature(message: publicKey)
          let record = try KyberPreKeyRecord(
            id: id, timestamp: self.nowMillis(), keyPair: pair, signature: signature)
          try self.store.storeKyberPreKey(record, id: id, context: self.context)
          if lastResort { try self.store.markLastResort(id) }
          return [
            "keyId": id,
            "publicKey": publicKey.base64EncodedString(),
            "signature": signature.base64EncodedString(),
          ]
        }
      }
    }

    AsyncFunction("hasSession") { (name: String, deviceId: Int) -> Bool in
      try self.serial {
        let address = try ProtocolAddress(name: name, deviceId: UInt32(deviceId))
        return try self.store.loadSession(for: address, context: self.context)?.hasCurrentState ?? false
      }
    }

    /// Starts a session from a device's published keys (PQXDH).
    AsyncFunction("processBundle") { (name: String, bundle: BundleRecord) in
      try self.serial {
        let address = try ProtocolAddress(name: name, deviceId: UInt32(bundle.deviceId))
        let identity = try IdentityKey(bytes: self.bytes(bundle.identityKey))
        let signedPreKey = try PublicKey(self.bytes(bundle.signedPreKey.publicKey))
        let kyberPreKey = try KEMPublicKey(self.bytes(bundle.kyberPreKey.publicKey))
        let made: PreKeyBundle
        if let pre = bundle.preKey {
          made = try PreKeyBundle(
            registrationId: UInt32(bundle.registrationId),
            deviceId: UInt32(bundle.deviceId),
            prekeyId: UInt32(pre.keyId),
            prekey: try PublicKey(self.bytes(pre.publicKey)),
            signedPrekeyId: UInt32(bundle.signedPreKey.keyId),
            signedPrekey: signedPreKey,
            signedPrekeySignature: self.bytes(bundle.signedPreKey.signature ?? ""),
            identity: identity,
            kyberPrekeyId: UInt32(bundle.kyberPreKey.keyId),
            kyberPrekey: kyberPreKey,
            kyberPrekeySignature: self.bytes(bundle.kyberPreKey.signature ?? ""))
        } else {
          made = try PreKeyBundle(
            registrationId: UInt32(bundle.registrationId),
            deviceId: UInt32(bundle.deviceId),
            signedPrekeyId: UInt32(bundle.signedPreKey.keyId),
            signedPrekey: signedPreKey,
            signedPrekeySignature: self.bytes(bundle.signedPreKey.signature ?? ""),
            identity: identity,
            kyberPrekeyId: UInt32(bundle.kyberPreKey.keyId),
            kyberPrekey: kyberPreKey,
            kyberPrekeySignature: self.bytes(bundle.kyberPreKey.signature ?? ""))
        }
        try processPreKeyBundle(
          made, for: address, ourAddress: try self.localAddress(name: bundle.localName),
          sessionStore: self.store, identityStore: self.store, context: self.context)
      }
    }

    /// Encrypts one plaintext (UTF-8) for each device. type 3 = prekey message, 2 = normal.
    AsyncFunction("encrypt") { (localName: String, plaintext: String, recipients: [AddressRecord]) -> [[String: Any]] in
      try self.serial {
        let message = Data(plaintext.utf8)
        let local = try self.localAddress(name: localName)
        return try recipients.map { r in
          let address = try ProtocolAddress(name: r.name, deviceId: UInt32(r.deviceId))
          let out = try signalEncrypt(
            message: message, for: address, localAddress: local, sessionStore: self.store,
            identityStore: self.store, context: self.context)
          return [
            "name": r.name,
            "deviceId": r.deviceId,
            "type": Int(out.messageType.rawValue),
            "body": out.serialize().base64EncodedString(),
          ]
        }
      }
    }

    AsyncFunction("decrypt") { (localName: String, name: String, deviceId: Int, type: Int, body: String) -> String in
      try self.serial {
        let address = try ProtocolAddress(name: name, deviceId: UInt32(deviceId))
        let local = try self.localAddress(name: localName)
        let data = try self.bytes(body)
        let plaintext: Data
        if type == Int(CiphertextMessage.MessageType.preKey.rawValue) {
          plaintext = try signalDecryptPreKey(
            message: try PreKeySignalMessage(bytes: data), from: address, localAddress: local,
            sessionStore: self.store, identityStore: self.store, preKeyStore: self.store,
            signedPreKeyStore: self.store, kyberPreKeyStore: self.store, context: self.context)
        } else if type == Int(CiphertextMessage.MessageType.whisper.rawValue) {
          plaintext = try signalDecrypt(
            message: try SignalMessage(bytes: data), from: address, to: local,
            sessionStore: self.store, identityStore: self.store, context: self.context)
        } else {
          throw SignalError.invalidMessage("Unsupported message type \(type)")
        }
        guard let text = String(data: plaintext, encoding: .utf8) else {
          throw SignalError.invalidMessage("Plaintext isn’t UTF-8")
        }
        return text
      }
    }

    /// Accept a device's new identity (after warning the user): forget the old
    /// key and session, so the next bundle starts afresh.
    AsyncFunction("forgetIdentity") { (name: String, deviceId: Int) in
      try self.serial {
        let address = try ProtocolAddress(name: name, deviceId: UInt32(deviceId))
        self.store.removeIdentity(for: address)
        self.store.removeSession(for: address)
      }
    }

    /// The remote device's identity key we trust, if any.
    AsyncFunction("remoteIdentity") { (name: String, deviceId: Int) -> String? in
      try self.serial {
        let address = try ProtocolAddress(name: name, deviceId: UInt32(deviceId))
        return try self.store.identity(for: address, context: self.context)?.serialize().base64EncodedString()
      }
    }

    /// Safety number between this device and a remote device (60 digits).
    /// Identifiers are the two account ids; both sides compute the same number.
    AsyncFunction("fingerprint") { (localId: String, remoteId: String, remoteIdentityKey: String) -> [String: String] in
      try self.serial {
        let mine = try self.store.identityKeyPair(context: self.context).identityKey
        let theirs = try IdentityKey(bytes: self.bytes(remoteIdentityKey))
        let fp = try NumericFingerprintGenerator(iterations: 5200).create(
          version: 2, localIdentifier: Data(localId.utf8), localKey: mine.publicKey,
          remoteIdentifier: Data(remoteId.utf8), remoteKey: theirs.publicKey)
        return ["displayable": fp.displayable.formatted, "scannable": fp.scannable.encoding.base64EncodedString()]
      }
    }

    /// Encrypts a file with a fresh random key (AES-256-GCM). The digest is the
    /// SHA-256 of the ciphertext, checked before decrypting.
    AsyncFunction("encryptFile") { (inputUri: String, outputUri: String) -> [String: String] in
      try self.files.sync {
        var key = Data(count: 32)
        let status = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw SignalError.invalidState("No randomness") }
        let plain = try Data(contentsOf: self.url(inputUri))
        let sealed = try Aes256GcmEncryptedData.encrypt(plain, key: key).concatenate()
        try sealed.write(to: self.url(outputUri), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return [
          "key": key.base64EncodedString(),
          "digest": Data(SHA256.hash(data: sealed)).base64EncodedString(),
          "size": String(sealed.count),
        ]
      }
    }

    AsyncFunction("decryptFile") { (inputUri: String, outputUri: String, key: String, digest: String) in
      try self.files.sync {
        let sealed = try Data(contentsOf: self.url(inputUri))
        guard Data(SHA256.hash(data: sealed)) == (try self.bytes(digest)) else {
          throw SignalError.invalidMessage("File digest doesn’t match")
        }
        let plain = try Aes256GcmEncryptedData(concatenated: sealed).decrypt(key: try self.bytes(key))
        try plain.write(to: self.url(outputUri), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }
    }

    /// 32 random bytes (call media keys).
    AsyncFunction("randomKey") { () -> String in
      var key = Data(count: 32)
      _ = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
      return key.base64EncodedString()
    }

    /// Sign-out: every key and session on this device.
    AsyncFunction("reset") {
      self.serial { self.store.wipe() }
    }
  }

  // MARK: Helpers

  private func serial<T>(_ body: () throws -> T) rethrows -> T {
    try queue.sync(execute: body)
  }

  private func nowMillis() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }

  private func bytes(_ base64: String) throws -> Data {
    guard let d = Data(base64Encoded: base64) else { throw SignalError.invalidArgument("Not base64") }
    return d
  }

  private func url(_ uri: String) throws -> URL {
    guard let u = URL(string: uri), u.isFileURL else { throw SignalError.invalidArgument("Not a file URL") }
    return u
  }

  /// This device's address; its device id is the registration-time number the server assigned.
  private func localAddress(name: String) throws -> ProtocolAddress {
    let parts = name.split(separator: ".")
    guard parts.count == 2, let device = UInt32(parts[1]) else {
      throw SignalError.invalidArgument("Local name must be userId.deviceId")
    }
    return try ProtocolAddress(name: String(parts[0]), deviceId: device)
  }
}

struct KeyRecord: Record {
  @Field var keyId: Int = 0
  @Field var publicKey: String = ""
  @Field var signature: String? = nil
}

struct BundleRecord: Record {
  /// "userId.deviceId" of this device.
  @Field var localName: String = ""
  @Field var deviceId: Int = 0
  @Field var registrationId: Int = 0
  @Field var identityKey: String = ""
  @Field var signedPreKey: KeyRecord = KeyRecord()
  @Field var kyberPreKey: KeyRecord = KeyRecord()
  @Field var preKey: KeyRecord? = nil
}

struct AddressRecord: Record {
  @Field var name: String = ""
  @Field var deviceId: Int = 0
}
