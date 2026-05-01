"""checkpoint_encryption.py — AES-256-GCM wrap/unwrap for trainer checkpoints.

The README's training lifecycle says "AES-GCM encrypt weights → upload
blob to 0G Storage → Merkle root → iNFT.dataHashes[1]". This module is
the encrypt/decrypt step.

Wire it like:

    raw_bytes = path.read_bytes()
    sealed   = encrypt_blob(raw_bytes, key=AGENT_OWNER_KEY)
    root     = upload_to_0g_storage(sealed)            # see og_storage_upload
    iNFT.update_dataHash(idx=1, root=root)             # settlement

…and on the read path:

    sealed   = fetch_from_0g_storage(root)
    raw_bytes = decrypt_blob(sealed, key=AGENT_OWNER_KEY)

Format:

    sealed = nonce(12 bytes) || ciphertext_with_tag

GCM produces a 16-byte authentication tag appended to the ciphertext
(this is what `cryptography`'s `AESGCM.encrypt` returns), so we don't
serialize it separately. The 12-byte nonce is the GCM-recommended
length; we generate it fresh per encryption with os.urandom and prepend
it to the output so the caller has only one blob to store.

Why AES-256-GCM (vs ChaCha20-Poly1305 / age / libsodium): GCM is in
Solidity's view "the standard symmetric AEAD" — well-audited, hardware-
accelerated on modern CPUs (AES-NI), available in every browser via
WebCrypto, and trivially supported by 0G's encryption SDK if/when we
move that direction. Other choices would work; this one is the most
boring / most portable.

Note on key custody: this module deliberately does NOT touch key
storage. Callers pass a 32-byte key. In production the key is gated
by ownership of the iNFT — selling the agent transfers the key
material via an encrypted side-channel — but the encryption primitive
itself stays simple.
"""
from __future__ import annotations

import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


KEY_BYTES = 32          # AES-256
NONCE_BYTES = 12        # GCM-recommended nonce length
TAG_BYTES = 16          # GCM authentication tag (AESGCM appends to ciphertext)


def generate_key() -> bytes:
    """Return a fresh 32-byte AES-256 key from os.urandom.

    Use once per agent / per checkpoint stream. The same key encrypts
    every checkpoint for one agent so a single owner-side decryption
    key suffices to read the whole training history."""
    return os.urandom(KEY_BYTES)


def encrypt_blob(plaintext: bytes, key: bytes, *,
                 associated_data: bytes | None = None) -> bytes:
    """AES-256-GCM-encrypt `plaintext` under `key`.

    Output layout: `nonce(12 bytes) || ciphertext_with_tag`. The nonce
    is fresh per call; reusing the same (key, nonce) pair against
    different plaintexts breaks GCM completely, so we never let the
    caller supply a nonce.

    `associated_data` is authenticated but not encrypted (e.g. an iNFT
    id, an agent's epoch counter). Pass the same value to
    `decrypt_blob` to verify integrity."""
    if len(key) != KEY_BYTES:
        raise ValueError(f"key must be {KEY_BYTES} bytes, got {len(key)}")
    aesgcm = AESGCM(key)
    nonce = os.urandom(NONCE_BYTES)
    ciphertext_with_tag = aesgcm.encrypt(nonce, plaintext, associated_data)
    return nonce + ciphertext_with_tag


def decrypt_blob(sealed: bytes, key: bytes, *,
                 associated_data: bytes | None = None) -> bytes:
    """Inverse of `encrypt_blob`. Raises on tag mismatch / wrong key /
    truncated blob.

    `associated_data` MUST match what was passed at encryption time;
    GCM authenticates it as part of the integrity check."""
    if len(key) != KEY_BYTES:
        raise ValueError(f"key must be {KEY_BYTES} bytes, got {len(key)}")
    if len(sealed) < NONCE_BYTES + TAG_BYTES:
        raise ValueError(
            f"sealed blob too short: got {len(sealed)} bytes, need at least "
            f"{NONCE_BYTES + TAG_BYTES} (nonce + tag)"
        )
    nonce, ciphertext_with_tag = sealed[:NONCE_BYTES], sealed[NONCE_BYTES:]
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(nonce, ciphertext_with_tag, associated_data)
