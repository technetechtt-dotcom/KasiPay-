# Incident response playbook (engineering template)

Use this during a live financial or availability incident. Fill evidence as you go.

## 1. Detect
- Source: on-call alert / `on_call_alerts` / monitoring page
- Severity: critical | high | medium
- First seen (UTC):
- Affected products: wallets | cash send | settlement | auth | other

## 2. Contain (first 15 minutes)
- [ ] Confirm `financial_posting` operational control state
- [ ] If money integrity at risk: leave posting **disabled** (do not re-enable without maker-checker)
- [ ] Freeze related provider endpoints if callbacks are harmful
- [ ] Capture request IDs / journal references / wallet IDs (no raw PII in chat)

## 3. Diagnose
- [ ] Latest reconciliation run state (`reconciliation_runs`)
- [ ] Open `reconciliation_exceptions` and `on_call_alerts`
- [ ] Drift proposals / wallet inventory sample
- [ ] Provider instruction stuck count
- [ ] Redis / DB / audit sink health from `/health/ready`

## 4. Remediate
- [ ] Prefer suspense journals via approved drift proposals — never direct wallet edits
- [ ] Re-run `reconcile:worker` after fix; require consecutive zero-drift cycles before re-enable
- [ ] Maker-checker approval to re-enable posting (`posting_control_enable`)

## 5. Communicate
- Internal war-room notes:
- External / merchant notice needed? yes/no
- Regulator notification needed? yes/no (legal decides)

## 6. Close
- Root cause:
- Evidence hashes / report URIs:
- Follow-ups filed:
- Post-incident review date:
