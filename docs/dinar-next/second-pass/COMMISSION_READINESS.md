# Commission threshold proposals — inactive

The owner approved 5% at or below a market threshold and 10% above, on the whole eligible item subtotal excluding separately recorded shipping/tax. Jordan’s historical decision is 20.000 JOD. The former eight-market plan used nominal 20 local units; the membership of those original eight was not supplied. Expanded 22-market thresholds remain unapproved.

The following nominal-20 proposals are review candidates, not FX equivalents or economic recommendations. Every rule is DRAFT, version1, approval=false, effective date unset, activation=false. They cannot change checkout or historical financial records.

| Market | Currency | Scale | Nominal 20-unit proposal (minor) | Historical decision |
| --- | --- | ---: | ---: | --- |
| AE | AED | 2 | 2000 | not established for expanded plan |
| BH | BHD | 3 | 20000 | not established for expanded plan |
| DJ | DJF | 0 | 20 | not established for expanded plan |
| DZ | DZD | 2 | 2000 | not established for expanded plan |
| EG | EGP | 2 | 2000 | not established for expanded plan |
| IQ | IQD | 3 | 20000 | not established for expanded plan |
| JO | JOD | 3 | 20000 | 20.000 JOD |
| KM | KMF | 0 | 20 | not established for expanded plan |
| KW | KWD | 3 | 20000 | not established for expanded plan |
| LB | LBP | 2 | 2000 | not established for expanded plan |
| LY | LYD | 3 | 20000 | not established for expanded plan |
| MA | MAD | 2 | 2000 | not established for expanded plan |
| MR | MRU | 2 | 2000 | not established for expanded plan |
| OM | OMR | 3 | 20000 | not established for expanded plan |
| PS | EGP | 2 | 2000 | not established for expanded plan |
| QA | QAR | 2 | 2000 | not established for expanded plan |
| SA | SAR | 2 | 2000 | not established for expanded plan |
| SD | SDG | 2 | 2000 | not established for expanded plan |
| SO | SOS | 2 | 2000 | not established for expanded plan |
| SY | SYP | 2 | 2000 | not established for expanded plan |
| TN | TND | 3 | 20000 | not established for expanded plan |
| YE | YER | 2 | 2000 | not established for expanded plan |

Review-only implementation: commission-policy.ts previewTieredCommission. Effective start is inclusive, end exclusive. Invalid version, absent threshold, currency/scale/scope mismatch, unsafe amount or inactive time window is BLOCKED. Neither approved=true nor a successful preview enables activation. The existing checkout resolver and stored policy rows are unchanged.

Rounding uses existing integer HALF_UP: floor((eligibleMinor × rateBps + 5000) / 10000), rejecting unsafe intermediate arithmetic. At 20.000 JOD: 1.000 JOD fee; at 20.001 JOD: 2.000 JOD fee. The upper rate applies to the entire amount, not merely 0.001 excess. Historical order snapshots, rate fallback and cumulative refund reversal retain the originally selected rate; they never reselect a tier after a refund or new policy.

Future activation requires owner-approved thresholds/effective dates, reviewed persistence/resolver integration, and separate release authorization. No new policy was published or applied.
