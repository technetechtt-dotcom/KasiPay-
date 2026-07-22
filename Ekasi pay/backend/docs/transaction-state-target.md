# Transaction-state target

Target model for later phases (not implemented by Phase 0):

`initiated -> authorized -> posted -> settled`

Terminal/exception states: `rejected`, `expired`, `cancelled`, `reversed`, `failed`, and `manual_review`.

Required invariants:

- State transitions are explicit, validated, timestamped, actor-attributed, and idempotent.
- A posted transaction has balanced immutable ledger entries; corrections are reversals, never edits.
- Provider acceptance and financial posting are separate facts.
- Settlement and reconciliation can identify unmatched, duplicated, late, and partially completed operations.
- Retries reuse an idempotency key and cannot create a second posting.

Phase 0 only introduces gates that stop new postings; it does not migrate existing domain-specific states to this target.
