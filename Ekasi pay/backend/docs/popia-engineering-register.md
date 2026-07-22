# POPIA engineering register (draft)

This is a technical inventory for counsel and the Information Officer. It is not
legal advice, a PAIA manual, or a claim of POPIA completion.

## Data inventory and default retention proposals

| Data class | Purpose | System | Proposed retention trigger | Technical disposition |
|---|---|---|---|---|
| Account identity and phone | authentication/service | `users` | account closure plus legally approved period | pseudonymise where financial records require linkage |
| PIN/password hashes | authentication | `users`, `ops_admin_users` | while account active | overwrite on change; never export |
| Session/device data | security | session/device tables | 90 days after expiry/revocation | delete identifiers; retain aggregated security metrics |
| Wallet/journal records | financial integrity | ledger tables | statutory period set by counsel | immutable restriction; export with access controls |
| KYC documents | identity/compliance | private object storage | case closure plus approved statutory period | quarantine, legal-hold check, provider deletion and audit |
| Recovery/OTP records | account security | reset tables/outbox | 90 days | delete code hashes and destinations |
| Audit events | fraud/security | audit/event tables | risk-approved period | append-only archive with restricted capability |
| Consent evidence | lawful-processing evidence | `consent_records` | approved limitation period | immutable version/hash record |
| Data-subject requests | rights administration | DSR tables | request closure plus approved period | preserve decision evidence, minimise attachments |

Retention values are proposals only. Owners must record the lawful basis,
statutory override, legal-hold process, deletion verification, and backup expiry.

## Vendor and cross-border register

The `privacy_vendors` table records purpose, data categories, processing
countries, cross-border status, safeguard basis, contract review, and next
review. Populate it before enabling any SMS, monitoring, cloud storage, identity,
or payment vendor. Attach signed agreements outside source control.

## Privacy impact assessment template

- Change owner, reviewers, date, systems and data-flow diagram
- Processing purpose, necessity, proportionality and lawful-basis decision
- Data subjects, fields, sources, recipients, countries and volumes
- Children/vulnerable persons and special-personal-information assessment
- Threats: misuse, linkage, enumeration, insider access, breach and over-retention
- Controls: minimisation, encryption, access, logging, retention and data rights
- Residual risk, accountable approver, expiry/review date and rollback plan

## Breach assessment template

- Detection time, incident commander, affected systems and containment actions
- Personal-information categories, approximate subjects/records and countries
- Confidentiality/integrity/availability impact and ongoing risk
- Evidence preservation, access-log review and credential/key rotation
- Processor/vendor notifications and contractual deadlines
- Information Officer/legal assessment of regulator and subject notification
- Approved message, support channel, remediation owner and post-incident review

Do not place raw IDs, documents, PINs, OTPs, tokens, passwords or provider
credentials in this template, tickets, chat, logs, or source control.
