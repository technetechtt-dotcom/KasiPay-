# Encryption key and PII pepper management

## Secrets (deployed)

| Secret | Purpose |
|---|---|
| `DATA_ENCRYPTION_KEY` | AES-256-GCM field encryption (32 bytes) |
| `DATA_ENCRYPTION_KEY_VERSION` | Active ciphertext version (`vN.…`) |
| `DATA_ENCRYPTION_KEY_PREVIOUS` | `version:key,…` for decrypt-during-rotation |
| `PII_HASH_PEPPER` | Blind-index HMAC pepper — **must differ** from encryption/JWT secrets |
| `PII_HASH_PEPPER_VERSION` | Active hash version (`vN:<hex>`) |
| `PII_HASH_PEPPER_PREVIOUS` | `version:pepper,…` for verify-during-rotation |

Startup validation (`validateProductionConfig`) refuses deployed boot when the
pepper is missing, too short, or equal to other secrets.

## Rotation procedure (encryption)

1. Generate new 32-byte key; set as `DATA_ENCRYPTION_KEY` with bumped `DATA_ENCRYPTION_KEY_VERSION`.
2. Move prior key into `DATA_ENCRYPTION_KEY_PREVIOUS` as `oldVersion:oldKey`.
3. Deploy; new writes use the active version; reads decrypt via version stamp.
4. Background-reencrypt remaining rows (`rotateFieldToActiveKey`) and track progress.
5. After 100% reencrypt + soak, remove retired keys from `PREVIOUS`.

## Rotation procedure (PII pepper)

1. Generate new pepper (≥32 chars), bump `PII_HASH_PEPPER_VERSION`.
2. Keep old pepper in `PII_HASH_PEPPER_PREVIOUS`.
3. Dual-write / rehash blind indexes; verify with `sensitiveIdentifierMatches`.
4. Retire previous pepper after full rehash.

## Lost or compromised key

1. Disable financial posting and Cash Send immediately.
2. Rotate keys; treat prior ciphertexts as potentially exposed.
3. Re-collect critical PII where recovery is impossible.
4. File incident + POPIA breach assessment if personal data may be readable.
5. Never log decrypted field values.
