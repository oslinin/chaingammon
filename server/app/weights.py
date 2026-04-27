"""
AES-GCM encryption helper for the gnubg base weights blob (Phase 8).

gnubg's neural network weights file (~399 KB at /usr/lib/gnubg/gnubg.wd
on Ubuntu) is the *intelligence* every agent runs against. We upload
it once to 0G Storage and put the resulting Merkle rootHash on every
agent iNFT's `dataHashes[0]`. Per-owner encryption is v2; v1 uses a
single server-held key (`BASE_WEIGHTS_ENCRYPTION_KEY` env var) so any
client we authorize can decrypt.

The envelope layout on 0G Storage:

    +----------+----------------+--------------------------+
    | version  | nonce (12 B)   | ciphertext+GCM-tag (rest)|
    | 1 byte   |                |                          |
    +----------+----------------+--------------------------+

The version byte is reserved so v2 can change layout (e.g. switch to
hybrid encryption keyed off the iNFT owner's public key) without
breaking v1 readers. v1 uses 0x01.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENVELOPE_VERSION_V1 = 0x01
NONCE_LEN = 12  # AES-GCM standard
KEY_LEN = 32  # AES-256


class WeightsCryptoError(RuntimeError):
    """Wraps any encryption-layer failure — bad key, tampered blob, malformed envelope."""


@dataclass(frozen=True)
class EncryptedWeights:
    """Parsed envelope. `ciphertext` includes GCM's auth tag."""

    version: int
    nonce: bytes
    ciphertext: bytes

    def to_bytes(self) -> bytes:
        return bytes([self.version]) + self.nonce + self.ciphertext

    @classmethod
    def from_bytes(cls, blob: bytes) -> "EncryptedWeights":
        if len(blob) < 1 + NONCE_LEN + 1:
            raise WeightsCryptoError(f"envelope too short: {len(blob)} bytes")
        version = blob[0]
        if version != ENVELOPE_VERSION_V1:
            raise WeightsCryptoError(f"unknown envelope version: {version!r}")
        nonce = blob[1 : 1 + NONCE_LEN]
        ciphertext = blob[1 + NONCE_LEN :]
        return cls(version=version, nonce=nonce, ciphertext=ciphertext)


def generate_key() -> bytes:
    """Fresh 32-byte AES-256 key. For one-time use during weights upload."""
    return secrets.token_bytes(KEY_LEN)


def encrypt_weights(plaintext: bytes, key: bytes) -> EncryptedWeights:
    """AES-256-GCM with a fresh random nonce per call."""
    if len(key) != KEY_LEN:
        raise WeightsCryptoError(f"AES-256 key must be {KEY_LEN} bytes, got {len(key)}")
    nonce = secrets.token_bytes(NONCE_LEN)
    ct = AESGCM(key).encrypt(nonce, plaintext, associated_data=None)
    return EncryptedWeights(version=ENVELOPE_VERSION_V1, nonce=nonce, ciphertext=ct)


def decrypt_weights(envelope: EncryptedWeights, key: bytes) -> bytes:
    """Inverse of `encrypt_weights`. Raises WeightsCryptoError on any failure
    (wrong key, tampered ciphertext, GCM tag mismatch)."""
    if len(key) != KEY_LEN:
        raise WeightsCryptoError(f"AES-256 key must be {KEY_LEN} bytes, got {len(key)}")
    try:
        return AESGCM(key).decrypt(envelope.nonce, envelope.ciphertext, associated_data=None)
    except InvalidTag as e:
        raise WeightsCryptoError("AES-GCM auth tag failed — wrong key or tampered blob") from e


def load_key_from_env() -> bytes:
    """Read `BASE_WEIGHTS_ENCRYPTION_KEY` (hex, 64 chars) from the env."""
    hex_key = os.environ.get("BASE_WEIGHTS_ENCRYPTION_KEY")
    if not hex_key:
        raise WeightsCryptoError("BASE_WEIGHTS_ENCRYPTION_KEY is not set")
    try:
        key = bytes.fromhex(hex_key.removeprefix("0x"))
    except ValueError as e:
        raise WeightsCryptoError("BASE_WEIGHTS_ENCRYPTION_KEY must be hex") from e
    if len(key) != KEY_LEN:
        raise WeightsCryptoError(
            f"BASE_WEIGHTS_ENCRYPTION_KEY must decode to {KEY_LEN} bytes, got {len(key)}"
        )
    return key
