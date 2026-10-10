package expo.modules.koodesignal

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.InvalidKeyIdException
import org.signal.libsignal.protocol.NoSessionException
import org.signal.libsignal.protocol.ReusedBaseKeyException
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.state.IdentityKeyStore
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.KyberPreKeyStore
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyStore
import org.signal.libsignal.protocol.state.SessionRecord
import org.signal.libsignal.protocol.state.SessionStore
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyStore

/**
 * libsignal's protocol stores, persisted as one encrypted file per item in the
 * app's no-backup directory (never backed up or transferred). Each file is
 * AES-256-GCM encrypted with a key held by the Android Keystore, so it can't be
 * read off the device. The counterpart of the iOS Keychain store; item names
 * and the trust rules are the same.
 */
class SignalFileStore(context: Context) :
  IdentityKeyStore, PreKeyStore, SignedPreKeyStore, KyberPreKeyStore, SessionStore {

  private val dir = File(context.noBackupFilesDir, "koode-signal").apply { mkdirs() }

  // ——— Encrypted items ———

  private fun secretKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  private fun file(key: String) = File(dir, key.toByteArray().joinToString("") { "%02x".format(it) })

  fun get(key: String): ByteArray? {
    val f = file(key)
    if (!f.exists()) return null
    val data = f.readBytes()
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, data, 0, 12))
    return cipher.doFinal(data, 12, data.size - 12)
  }

  fun set(key: String, value: ByteArray) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val sealed = cipher.iv + cipher.doFinal(value)
    val temp = File(dir, ".${file(key).name}.part")
    temp.writeBytes(sealed)
    if (!temp.renameTo(file(key))) throw IllegalStateException("Couldn’t save $key")
  }

  fun remove(key: String) {
    file(key).delete()
  }

  /** Everything this store ever wrote (sign-out). The Keystore key goes too. */
  fun wipe() {
    dir.listFiles()?.forEach { it.delete() }
    KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY_ALIAS)
  }

  private fun name(a: SignalProtocolAddress) = "${a.name}.${a.deviceId}"

  // ——— Identity ———

  override fun getIdentityKeyPair(): IdentityKeyPair =
    IdentityKeyPair(get("identity") ?: throw IllegalStateException("No identity key"))

  override fun getLocalRegistrationId(): Int {
    val data = get("registration") ?: throw IllegalStateException("No registration id")
    return String(data).toInt()
  }

  override fun saveIdentity(
    address: SignalProtocolAddress,
    identityKey: IdentityKey,
  ): IdentityKeyStore.IdentityChange {
    val key = "rid.${name(address)}"
    val old = get(key)
    set(key, identityKey.serialize())
    return if (old == null || old.contentEquals(identityKey.serialize()))
      IdentityKeyStore.IdentityChange.NEW_OR_UNCHANGED
    else IdentityKeyStore.IdentityChange.REPLACED_EXISTING
  }

  /**
   * Trust on first use. A device's identity never legitimately changes (a new
   * device is a new address), so a different key is refused.
   */
  override fun isTrustedIdentity(
    address: SignalProtocolAddress,
    identityKey: IdentityKey,
    direction: IdentityKeyStore.Direction,
  ): Boolean {
    val known = get("rid.${name(address)}") ?: return true
    return known.contentEquals(identityKey.serialize())
  }

  override fun getIdentity(address: SignalProtocolAddress): IdentityKey? =
    get("rid.${name(address)}")?.let { IdentityKey(it) }

  fun removeIdentity(address: SignalProtocolAddress) = remove("rid.${name(address)}")

  // ——— Prekeys ———

  override fun loadPreKey(preKeyId: Int): PreKeyRecord =
    PreKeyRecord(get("pk.$preKeyId") ?: throw InvalidKeyIdException("prekey $preKeyId"))

  override fun storePreKey(preKeyId: Int, record: PreKeyRecord) = set("pk.$preKeyId", record.serialize())

  override fun containsPreKey(preKeyId: Int) = file("pk.$preKeyId").exists()

  override fun removePreKey(preKeyId: Int) = remove("pk.$preKeyId")

  override fun loadSignedPreKey(signedPreKeyId: Int): SignedPreKeyRecord =
    SignedPreKeyRecord(get("spk.$signedPreKeyId") ?: throw InvalidKeyIdException("signed prekey $signedPreKeyId"))

  override fun loadSignedPreKeys(): List<SignedPreKeyRecord> = emptyList()

  override fun storeSignedPreKey(signedPreKeyId: Int, record: SignedPreKeyRecord) =
    set("spk.$signedPreKeyId", record.serialize())

  override fun containsSignedPreKey(signedPreKeyId: Int) = file("spk.$signedPreKeyId").exists()

  override fun removeSignedPreKey(signedPreKeyId: Int) = remove("spk.$signedPreKeyId")

  override fun loadKyberPreKey(kyberPreKeyId: Int): KyberPreKeyRecord =
    KyberPreKeyRecord(get("kpk.$kyberPreKeyId") ?: throw InvalidKeyIdException("kyber prekey $kyberPreKeyId"))

  override fun loadKyberPreKeys(): List<KyberPreKeyRecord> = emptyList()

  override fun storeKyberPreKey(kyberPreKeyId: Int, record: KyberPreKeyRecord) =
    set("kpk.$kyberPreKeyId", record.serialize())

  override fun containsKyberPreKey(kyberPreKeyId: Int) = file("kpk.$kyberPreKeyId").exists()

  fun markLastResort(id: Int) = set("kpk-last-resort.$id", byteArrayOf(1))

  /**
   * One-time Kyber prekeys are deleted after use. The last-resort key stays,
   * but each (key, signed prekey, base key) combination is accepted only once,
   * as in libsignal's reference store.
   */
  override fun markKyberPreKeyUsed(kyberPreKeyId: Int, signedPreKeyId: Int, baseKey: ECPublicKey) {
    if (!file("kpk-last-resort.$kyberPreKeyId").exists()) {
      remove("kpk.$kyberPreKeyId")
      return
    }
    val seenKey = "kpk-seen.$kyberPreKeyId.$signedPreKeyId"
    val seen = get(seenKey) ?: ByteArray(0)
    val base = baseKey.serialize()
    var offset = 0
    while (offset + base.size <= seen.size) {
      if (seen.copyOfRange(offset, offset + base.size).contentEquals(base)) throw ReusedBaseKeyException()
      offset += base.size
    }
    set(seenKey, seen + base)
  }

  // ——— Sessions ———

  override fun loadSession(address: SignalProtocolAddress): SessionRecord? =
    get("session.${name(address)}")?.let { SessionRecord(it) }

  override fun loadExistingSessions(addresses: List<SignalProtocolAddress>): List<SessionRecord> =
    addresses.map { loadSession(it) ?: throw NoSessionException("no session for $it") }

  override fun getSubDeviceSessions(name: String): List<Int> = emptyList()

  override fun storeSession(address: SignalProtocolAddress, record: SessionRecord) =
    set("session.${name(address)}", record.serialize())

  override fun containsSession(address: SignalProtocolAddress) =
    loadSession(address)?.hasSenderChain() ?: false

  override fun deleteSession(address: SignalProtocolAddress) = remove("session.${name(address)}")

  override fun deleteAllSessions(name: String) {}

  companion object {
    private const val KEY_ALIAS = "koode.signal"
  }
}
