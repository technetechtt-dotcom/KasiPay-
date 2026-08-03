# Non-funds merchant pilot rehearsal

Money-movement flags stay **false**. This rehearsal proves shop ops, offline
queue, i18n, and support contacts — not custody of customer funds.

## Preconditions

- [ ] Tip SHA on `main` has green CI (`validate` + sibling jobs)
- [ ] Regulated flags false on API + reconcile worker
- [ ] Real `VITE_SUPPORT_*` set on `ekasi-pay-web` (no example numbers)
- [ ] Pilot merchants (5–10) onboarded with docs; approval status tracked

## Device script (per merchant)

1. [ ] Switch language to zu / xh / af / tn — Auth, Transfer shell, Cash Send tabs, Onboarding readable
2. [ ] Create offline cash sale → appears in outbox while offline
3. [ ] Restock + add new product while offline → queued
4. [ ] Reconnect → outbox flush; stock and sales match server
5. [ ] Open Cash Send / lending / insurance / utilities → disabled / unavailable notices only
6. [ ] Help page shows real WhatsApp / phone / email
7. [ ] Capture Account Settings → Diagnostics sample for support

## Stop conditions

- Any regulated money flag unexpectedly true → pause pilot, investigate
- Outbox loss or silent stock drift → stop device tests, open ops exception
- Support contacts missing or placeholder → do not start field visits

## Evidence to file

| Artifact | Location / URI |
|---|---|
| Tip SHA + CI URL | |
| Support env screenshot (redacted) | |
| Pilot diary (dates, shops, issues) | |
| Diagnostics sample | |
