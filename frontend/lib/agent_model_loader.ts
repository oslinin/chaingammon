/**
 * Browser-side loader for per-agent ONNX models stored on 0G Storage.
 *
 * Two blob formats are supported at the rootHash:
 *   - Raw ONNX (protobuf, starts with 0x08): loaded directly into ORT.
 *   - Encrypted ONNX (starts with magic "CGONNX\x01"): must be decrypted
 *     first using the owner's AES-256-GCM key.
 *
 * Encryption format (produced by agent/sample_trainer.py seal_onnx):
 *   CGONNX\x01 (7 bytes) | nonce (12 bytes) | ciphertext + GCM tag
 *
 * Key derivation: owner signs a deterministic message with their wallet.
 * The signature is SHA-256-hashed to a 32-byte AES key. Whoever holds
 * the NFT can re-derive the same key by signing the same message.
 */

const OG_INDEXER = "https://indexer-storage-testnet-turbo.0g.ai";
const ZERO_HASH = "0x" + "0".repeat(64);

// "CGONNX\x01" — magic prefix for encrypted ONNX blobs
const ENCRYPTED_MAGIC = new Uint8Array([0x43, 0x47, 0x4f, 0x4e, 0x4e, 0x58, 0x01]);
const MAGIC_LEN = ENCRYPTED_MAGIC.length; // 7
const NONCE_LEN = 12;

function isEncryptedOnnx(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC_LEN) return false;
  return ENCRYPTED_MAGIC.every((b, i) => bytes[i] === b);
}

async function decryptOnnx(sealed: Uint8Array, key: Uint8Array): Promise<ArrayBuffer> {
  // Layout: magic(7) | nonce(12) | ciphertext+tag
  // Use ArrayBuffer slices — some TS DOM lib versions reject Uint8Array views
  // in SubtleCrypto overloads.
  const nonceArr = sealed.slice(MAGIC_LEN, MAGIC_LEN + NONCE_LEN);
  const ciphertextArr = sealed.slice(MAGIC_LEN + NONCE_LEN);
  const nonce = nonceArr.buffer.slice(nonceArr.byteOffset, nonceArr.byteOffset + nonceArr.byteLength) as ArrayBuffer;
  const ciphertext = ciphertextArr.buffer.slice(ciphertextArr.byteOffset, ciphertextArr.byteOffset + ciphertextArr.byteLength) as ArrayBuffer;
  const keyBuf = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;

  const subtle = crypto.subtle;
  const cryptoKey = await subtle.importKey("raw", keyBuf, { name: "AES-GCM" }, false, ["decrypt"] as KeyUsage[]);
  return subtle.decrypt({ name: "AES-GCM", iv: nonce } as AesGcmParams, cryptoKey, ciphertext);
}

/**
 * Derive a 32-byte AES-256 key from a wallet signature over a deterministic
 * message. Whoever holds the agent NFT can re-derive the same key.
 *
 * `signMessage` is wagmi's `walletClient.signMessage` or equivalent.
 */
export async function deriveModelKey(
  signMessage: (args: { message: string }) => Promise<`0x${string}`>,
  agentId: number,
): Promise<Uint8Array> {
  const sig = await signMessage({
    message: `chaingammon:model-key:v1:${agentId}`,
  });
  // sig is 0x-prefixed hex (130 hex chars = 65 bytes for secp256k1)
  const hex = sig.slice(2);
  const sigBytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const keyBuf = await crypto.subtle.digest("SHA-256", sigBytes);
  return new Uint8Array(keyBuf);
}

/**
 * Fetch raw bytes for a root hash from 0G Storage indexer.
 * Returns null when the hash is zero or the fetch fails silently.
 */
export async function fetchModelBytes(rootHash: string): Promise<Uint8Array | null> {
  if (!rootHash || rootHash === ZERO_HASH) return null;
  try {
    const resp = await fetch(`${OG_INDEXER}/file?root=${rootHash}`);
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Fetch the per-agent ONNX model from 0G Storage and return its bytes.
 *
 * - If the blob is unencrypted ONNX, it is returned as-is.
 * - If the blob has the CGONNX magic prefix, it is decrypted using `key`.
 *   Pass `key` from `deriveModelKey` (only the agent owner can decrypt).
 * - Returns null when the hash is zero, the fetch fails, or decryption
 *   fails (wrong key, corrupt blob, not an ONNX).
 */
export async function loadAgentOnnxBytes(
  rootHash: string,
  key?: Uint8Array,
): Promise<ArrayBuffer | null> {
  const bytes = await fetchModelBytes(rootHash);
  if (!bytes || bytes.length === 0) return null;

  if (isEncryptedOnnx(bytes)) {
    if (!key) return null; // encrypted but no key supplied — skip
    try {
      return await decryptOnnx(bytes, key);
    } catch {
      return null; // wrong key or corrupt ciphertext
    }
  }

  // Unencrypted: verify it looks like ONNX protobuf (field-1 varint header)
  // before returning — avoids loading PyTorch ZIP or JSON into ORT.
  if (bytes[0] === 0x08) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  return null;
}
