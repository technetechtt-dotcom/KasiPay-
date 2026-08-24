# Payment rails

Provider-neutral orchestration lives in `src/payments/`.

Launch rails (registered at boot):

- `internal_wallet`
- `cash`
- `bank_deposit`
- `bank_payout`
- `cash_send`

Optional future stubs exist in `rails/optionalRails.ts` but are **not registered**:

- `payshap`
- `card` (PCI PSP / hosted tokens only — do not take raw cards)
- `instant_eft`
- `bank_eft`
- `qr`

Requesting an unregistered rail (`requestedRail: 'payshap'`) fails closed.

`payment_intents` rows are written only for orchestrated/external rails. Launch
rails that post in-process (`internal_wallet`, `cash`, `cash_send`) do not
insert an intent; the journal is authoritative.

## Interface

```ts
authorize / capture / status / refund / reverse / reconcile
```

Capability declarations make missing operations explicit. Not every rail
implements every method.

States: `created`, `pending`, `authorized`, `submitted`, `processing`,
`fulfilled`, `failed`, `unknown`, `reversed`, `refunded`, `cancelled`.

External bank payout and PayShap adapters are **BLOCKED** until a contracted
provider and credentials exist. `ProviderSimulator` is test-only.
