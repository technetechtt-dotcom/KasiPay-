# Authorization matrix

| Capability | Customer | Approved merchant | Pending/rejected merchant | App admin | Ops operator |
| --- | --- | --- | --- | --- | --- |
| Login, own profile, permitted wallet reads | Yes | Yes | Yes | Yes | Separate ops login |
| Merchant profile/doc submission | Own profile | Own profile | Own profile | Read/review | Read/review by assigned role |
| Merchant shop APIs | No | Yes | No | Investigation only unless route explicitly allows | Investigation only |
| Customer-only APIs | Yes | Yes where applicable | Yes where not merchant-restricted | As explicitly authorized | No |
| Merchant approve/reject | No | No | No | Yes | Assigned ops roles |
| Financial posting | Only when global/product flags permit | Only when approved and flags permit | No | No implicit override | No implicit override |
| Audit/reconciliation reads | No | No | No | Yes | Assigned ops roles |

Rules: deny by default; merchant context requires an approved merchant row, not only a role claim; rejection requires a reason; approval requires every configured document type. Break-glass access is not implemented and must not be simulated by changing product data.
