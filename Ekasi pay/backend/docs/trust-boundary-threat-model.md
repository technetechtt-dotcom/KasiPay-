# Trust boundaries and threat-model overview

## Boundaries

1. Public web/mobile and ops clients to the API: all input, role claims outside verified JWTs, headers, and uploaded files are untrusted.
2. API to PostgreSQL/SQLite: the API is the authorization and transaction boundary; direct database access is privileged.
3. API to SMS, utility, hosting and future regulated providers: provider responses/webhooks are untrusted until authenticated and reconciled.
4. App-admin and ops identities: privileged but distinct; actions require attribution and least privilege.
5. Merchant/customer boundary: possession of a token or role does not prove an approved merchant context.

## Priority threats and Phase 0 controls

- Unauthorized or self-approved merchant activity: new profiles start `pending_docs`; all documents are required; merchant-context checks deny unapproved profiles.
- Accidental production money movement: global posting kill switch plus product-specific fail-closed flags.
- Replay/double posting: existing idempotency on key routes; full coverage remains later work.
- Privilege misuse: audit events and separate ops authentication exist; role review and break-glass design remain required.
- PII/document exposure: authenticated document access exists; malware scanning, object storage, retention and encryption-key decisions remain required.
- Provider inconsistency: live utility products default off; signed callbacks and reconciliation remain required.
