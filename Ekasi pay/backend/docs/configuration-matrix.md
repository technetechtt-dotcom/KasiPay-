# Production configuration matrix

Boolean flags accept `true/false`, `1/0`, `yes/no`, or `on/off` (case-insensitive). Invalid values stop startup.

| Variable | Development default | Production default | Purpose |
| --- | --- | --- | --- |
| `FINANCIAL_POSTING_ENABLED` | enabled | disabled | Global kill switch for new money postings |
| `LENDING_DISBURSEMENT_ENABLED` | enabled | disabled | Loan disbursement |
| `INSURANCE_ENABLED` | enabled | disabled | Policy activation/creation and claim approval/payment |
| `STOKVEL_MONEY_MOVEMENT_ENABLED` | enabled | disabled | Contributions, pool loans and repayments |
| `LIVE_UTILITIES_ENABLED` | enabled | disabled | Utility purchase mutation |
| `UTILITY_PROVIDER` | `mock` | `disabled` | Provider adapter; production mock is rejected |
| `JWT_SECRET` | development fallback | required, >=32 chars | JWT signing |
| `SMS_PROVIDER` | `console` | real configured provider required | Authentication/notification delivery |

Enabling a product-specific flag does not override `FINANCIAL_POSTING_ENABLED`. Configuration changes require change approval, an incident rollback owner, evidence of provider/legal gates, and post-deployment verification.
