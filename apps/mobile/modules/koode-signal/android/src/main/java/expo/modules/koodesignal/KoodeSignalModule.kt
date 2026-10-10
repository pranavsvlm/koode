package expo.modules.koodesignal

import android.net.Uri
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import org.signal.libsignal.crypto.Aes256GcmDecryption
import org.signal.libsignal.crypto.Aes256GcmEncryption
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.fingerprint.NumericFingerprintGenerator
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType
import org.signal.libsignal.protocol.kem.KEMPublicKey
import org.signal.libsignal.protocol.message.CiphertextMessage
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.message.SignalMessage
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyBundle
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord

/**
 * End-to-end encryption with Signal's libsignal (Android). Same API as the iOS
 * module: binary values cross the bridge as base64 strings, message plaintext
 * as UTF-8 text. Protocol calls are serialized (the stores aren't safe to use
 * concurrently); file encryption doesn't touch them.
 */
class KoodeSignalModule : Module() {
  private val lock = Any()
  private val random = SecureRandom()
  private val store by lazy {
    SignalFileStore(appContext.reactContext ?: throw IllegalStateException("No React context"))
  }

  override fun definition() = ModuleDefinition {
    Name("KoodeSignal")

    /** Creates this device's identity key and registration id once. */
    AsyncFunction("ensureIdentity") {
      synchronized(lock) {
        var created = false
        if (store.get("identity") == null) {
          store.set("identity", IdentityKeyPair.generate().serialize())
          store.set("registration", (1 + random.nextInt(16380)).toString().toByteArray())
          created = true
        }
        mapOf(
          "identityKey" to b64(store.identityKeyPair.publicKey.serialize()),
          "registrationId" to store.localRegistrationId,
          "created" to created,
        )
      }
    }

    AsyncFunction("generatePreKeys") { startId: Int, count: Int ->
      synchronized(lock) {
        (0 until count).map { i ->
          val id = startId + i
          val pair = ECKeyPair.generate()
          store.storePreKey(id, PreKeyRecord(id, pair))
          mapOf("keyId" to id, "publicKey" to b64(pair.publicKey.serialize()))
        }
      }
    }

    AsyncFunction("generateSignedPreKey") { id: Int ->
      synchronized(lock) {
        val pair = ECKeyPair.generate()
        val publicKey = pair.publicKey.serialize()
        val signature = store.identityKeyPair.privateKey.calculateSignature(publicKey)
        store.storeSignedPreKey(id, SignedPreKeyRecord(id, System.currentTimeMillis(), pair, signature))
        mapOf("keyId" to id, "publicKey" to b64(publicKey), "signature" to b64(signature))
      }
    }

    /** One-time Kyber prekeys, or (lastResort) the single long-lived one. */
    AsyncFunction("generateKyberPreKeys") { startId: Int, count: Int, lastResort: Boolean ->
      synchronized(lock) {
        val identity = store.identityKeyPair
        (0 until count).map { i ->
          val id = startId + i
          val pair = KEMKeyPair.generate(KEMKeyType.KYBER_1024)
          val publicKey = pair.publicKey.serialize()
          val signature = identity.privateKey.calculateSignature(publicKey)
          store.storeKyberPreKey(id, KyberPreKeyRecord(id, System.currentTimeMillis(), pair, signature))
          if (lastResort) store.markLastResort(id)
          mapOf("keyId" to id, "publicKey" to b64(publicKey), "signature" to b64(signature))
        }
      }
    }

    AsyncFunction("hasSession") { name: String, deviceId: Int ->
      synchronized(lock) { store.containsSession(SignalProtocolAddress(name, deviceId)) }
    }

    /** Starts a session from a device's published keys (PQXDH). */
    AsyncFunction("processBundle") { name: String, bundle: BundleRecord ->
      synchronized(lock) {
        val pre = bundle.preKey
        val made = PreKeyBundle(
          bundle.registrationId,
          bundle.deviceId,
          pre?.keyId ?: PreKeyBundle.NULL_PRE_KEY_ID,
          pre?.let { ECPublicKey(bytes(it.publicKey)) },
          bundle.signedPreKey.keyId,
          ECPublicKey(bytes(bundle.signedPreKey.publicKey)),
          bytes(bundle.signedPreKey.signature ?: ""),
          IdentityKey(bytes(bundle.identityKey)),
          bundle.kyberPreKey.keyId,
          KEMPublicKey(bytes(bundle.kyberPreKey.publicKey)),
          bytes(bundle.kyberPreKey.signature ?: ""),
        )
        SessionBuilder(store, store, store, store, SignalProtocolAddress(name, bundle.deviceId), local(bundle.localName))
          .process(made)
      }
    }

    /** Encrypts one plaintext (UTF-8) for each device. type 3 = prekey message, 2 = normal. */
    AsyncFunction("encrypt") { localName: String, plaintext: String, recipients: List<AddressRecord> ->
      synchronized(lock) {
        val message = plaintext.toByteArray(Charsets.UTF_8)
        recipients.map { r ->
          val out = cipher(localName, r.name, r.deviceId).encrypt(message)
          mapOf("name" to r.name, "deviceId" to r.deviceId, "type" to out.type, "body" to b64(out.serialize()))
        }
      }
    }

    AsyncFunction("decrypt") { localName: String, name: String, deviceId: Int, type: Int, body: String ->
      synchronized(lock) {
        val data = bytes(body)
        val c = cipher(localName, name, deviceId)
        val plain = when (type) {
          CiphertextMessage.PREKEY_TYPE -> c.decrypt(PreKeySignalMessage(data))
          CiphertextMessage.WHISPER_TYPE -> c.decrypt(SignalMessage(data))
          else -> throw CodedException("Unsupported message type $type")
        }
        String(plain, Charsets.UTF_8)
      }
    }

    /** The remote device's identity key we trust, if any. */
    AsyncFunction("remoteIdentity") { name: String, deviceId: Int ->
      synchronized(lock) { store.getIdentity(SignalProtocolAddress(name, deviceId))?.let { b64(it.serialize()) } }
    }

    /** Accept a device's new identity (after warning the user). */
    AsyncFunction("forgetIdentity") { name: String, deviceId: Int ->
      synchronized(lock) {
        val address = SignalProtocolAddress(name, deviceId)
        store.removeIdentity(address)
        store.deleteSession(address)
      }
    }

    /** Safety number between this device and a remote device (60 digits). */
    AsyncFunction("fingerprint") { localId: String, remoteId: String, remoteIdentityKey: String ->
      synchronized(lock) {
        val fp = NumericFingerprintGenerator(5200).createFor(
          2,
          localId.toByteArray(),
          store.identityKeyPair.publicKey,
          remoteId.toByteArray(),
          IdentityKey(bytes(remoteIdentityKey)),
        )
        mapOf(
          "displayable" to fp.displayableFingerprint.displayText,
          "scannable" to b64(fp.scannableFingerprint.serialized),
        )
      }
    }

    /**
     * Encrypts a file with a fresh random key (AES-256-GCM), streaming in
     * chunks: libsignal's attachment layout (nonce ‖ ciphertext ‖ tag); the
     * digest is the SHA-256 of all of it.
     */
    AsyncFunction("encryptFile") { inputUri: String, outputUri: String ->
      val key = randomBytes(32)
      val nonce = randomBytes(12)
      val cipher = Aes256GcmEncryption(key, nonce, ByteArray(0))
      val output = file(outputUri)
      val temp = File(output.parentFile, ".${output.name}.part")
      val digest = MessageDigest.getInstance("SHA-256")
      var size = 0L
      try {
        file(inputUri).inputStream().use { input ->
          temp.outputStream().use { out ->
            out.write(nonce)
            digest.update(nonce)
            size += nonce.size
            val buffer = ByteArray(CHUNK)
            while (true) {
              val n = input.read(buffer)
              if (n < 0) break
              val chunk = buffer.copyOf(n)
              cipher.encrypt(chunk)
              out.write(chunk)
              digest.update(chunk)
              size += n
            }
            val tag = cipher.computeTag()
            out.write(tag)
            digest.update(tag)
            size += tag.size
          }
        }
        if (!temp.renameTo(output)) throw CodedException("Couldn’t write the encrypted file")
      } catch (e: Exception) {
        temp.delete()
        throw e
      }
      mapOf("key" to b64(key), "digest" to b64(digest.digest()), "size" to size.toString())
    }

    /** Checks the digest, then decrypts in chunks and verifies the tag. */
    AsyncFunction("decryptFile") { inputUri: String, outputUri: String, key: String, digest: String ->
      val input = file(inputUri)
      val total = input.length()
      val hash = MessageDigest.getInstance("SHA-256")
      input.inputStream().use { s ->
        val buffer = ByteArray(CHUNK)
        while (true) {
          val n = s.read(buffer)
          if (n < 0) break
          hash.update(buffer, 0, n)
        }
      }
      if (!hash.digest().contentEquals(bytes(digest))) throw CodedException("File digest doesn’t match")
      if (total < 28) throw CodedException("File is too short")
      val output = file(outputUri)
      val temp = File(output.parentFile, ".${output.name}.part")
      try {
        input.inputStream().use { s ->
          val nonce = ByteArray(12).also { readFully(s, it) }
          val cipher = Aes256GcmDecryption(bytes(key), nonce, ByteArray(0))
          var remaining = total - 12 - 16
          temp.outputStream().use { out ->
            val buffer = ByteArray(CHUNK)
            while (remaining > 0) {
              val n = s.read(buffer, 0, minOf(CHUNK.toLong(), remaining).toInt())
              if (n < 0) throw CodedException("File ended early")
              val chunk = buffer.copyOf(n)
              cipher.decrypt(chunk)
              out.write(chunk)
              remaining -= n
            }
          }
          val tag = ByteArray(16).also { readFully(s, it) }
          if (!cipher.verifyTag(tag)) throw CodedException("File failed authentication")
        }
        if (output.exists()) output.delete()
        if (!temp.renameTo(output)) throw CodedException("Couldn’t write the decrypted file")
      } catch (e: Exception) {
        temp.delete()
        throw e
      }
    }

    /** 32 random bytes (call media keys). */
    AsyncFunction("randomKey") { b64(randomBytes(32)) }

    /** Sign-out: every key and session on this device. */
    AsyncFunction("reset") { synchronized(lock) { store.wipe() } }
  }

  // ——— Helpers ———

  private fun cipher(localName: String, name: String, deviceId: Int) =
    SessionCipher(store, store, store, store, store, SignalProtocolAddress(name, deviceId), local(localName))

  /** This device's address: "userId.deviceId". */
  private fun local(name: String): SignalProtocolAddress {
    val parts = name.split(".")
    val device = parts.getOrNull(1)?.toIntOrNull()
    if (parts.size != 2 || device == null) throw CodedException("Local name must be userId.deviceId")
    return SignalProtocolAddress(parts[0], device)
  }

  private fun b64(data: ByteArray) = Base64.encodeToString(data, Base64.NO_WRAP)

  private fun bytes(base64: String): ByteArray =
    try {
      Base64.decode(base64, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      throw CodedException("Not base64")
    }

  private fun randomBytes(n: Int) = ByteArray(n).also { random.nextBytes(it) }

  private fun file(uri: String): File {
    val parsed = Uri.parse(uri)
    if (parsed.scheme != "file" || parsed.path == null) throw CodedException("Not a file URL")
    return File(parsed.path!!)
  }

  private fun readFully(s: java.io.InputStream, into: ByteArray) {
    var read = 0
    while (read < into.size) {
      val n = s.read(into, read, into.size - read)
      if (n < 0) throw CodedException("File ended early")
      read += n
    }
  }

  companion object {
    private const val CHUNK = 1 shl 20
  }
}

class KeyRecord : Record {
  @Field var keyId: Int = 0
  @Field var publicKey: String = ""
  @Field var signature: String? = null
}

class BundleRecord : Record {
  /** "userId.deviceId" of this device. */
  @Field var localName: String = ""
  @Field var deviceId: Int = 0
  @Field var registrationId: Int = 0
  @Field var identityKey: String = ""
  @Field var signedPreKey: KeyRecord = KeyRecord()
  @Field var kyberPreKey: KeyRecord = KeyRecord()
  @Field var preKey: KeyRecord? = null
}

class AddressRecord : Record {
  @Field var name: String = ""
  @Field var deviceId: Int = 0
}
