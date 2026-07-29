# Fraud response playbook (engineering template)

## 1. Triage
- Case ID / hold ID:
- Priority: critical | high | medium
- Suspected typology: ATO | mule | voucher abuse | chargeback | other

## 2. Immediate controls
- [ ] Leave or place transaction hold
- [ ] Confirm financial posting kill-switch if systemic
- [ ] Freeze subject user/merchant if capability allows
- [ ] Preserve immutable audit + fraud case notes (no edits)

## 3. Evidence pack
- Wallet IDs / financial references:
- Device / velocity signals (if available):
- Provider callback / settlement refs:
- Screenshots or export digests (hash only in tickets)

## 4. Decision
- Release hold / reject / escalate to law enforcement / file SAR (legal)
- Maker-checker if refund or balance adjustment required

## 5. Close
- Resolution note on fraud case
- Customer communication owner:
- Lessons for risk rules:
