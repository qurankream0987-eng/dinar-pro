from pathlib import Path
import json
b=Path('/workspace/dinar-connect-evidence');p=b/'functional-audit-feature-traces-current-prepared.json';a=json.loads(p.read_text());decl=json.loads((b/'functional-audit-declaration-traces-current.json').read_text())['apiDeclarations'];lookup={(d['method'],d['path']):d for d in decl};turn=('POST','/ai/conversations/:id/turns')
ops={
'AUTH':[('POST','/auth/phone-verification/challenges'),('POST','/auth/phone-verification/challenges/verify'),('POST','/auth/register'),('POST','/auth/login'),('POST','/auth/logout'),('GET','/auth/me'),('PATCH','/account/profile'),('POST','/account/password'),('POST','/account/profile-avatar/upload-url'),('PUT','/account/profile-avatar')],
'SEARCH':[turn,('GET','/listings')],'COMPARE':[turn],'NEGOTIATE':[turn,('POST','/checkout')],
'EMPLOYMENT':[turn,('POST','/ai/employment-actions/:id/action')],'INQUIRY':[turn],
'RUNTIME':[('POST','/ai/conversations'),('GET','/ai/conversations'),('GET','/ai/conversations/:id'),turn],
'DRIVER':[turn,('POST','/admin/drivers/:id/review')],
'DELIVERY':[turn,('GET','/orders/:id/fulfillment'),('GET','/orders/:id/tracking'),('GET','/orders/:id/courier-fare'),('POST','/orders/:id/courier-fare/proposals'),('POST','/orders/:id/courier-fare/confirm')],
'MEMORY':[turn,('GET','/account/privacy/preferences'),('PATCH','/account/privacy/preferences')],
'USAGE':[turn,('GET','/business/subscription')],'MODEL':[turn],
'DOMAIN':[turn,('POST','/connect/outbound'),('GET','/connect/outbound/:id')],
'EXTERNAL':[('POST','/connect/outbound'),('GET','/connect/outbound/:id'),('POST','/connect/privacy/attribution')],
'TUTORIAL':[turn,('GET','/ai/learning-history'),('POST','/ai/learning-history')],
'SUBSCRIPTION':[('GET','/subscriptions/plans'),('GET','/business/subscription'),('POST','/business/subscription-review'),('POST','/business/subscriptions'),('POST','/business/subscription/cancel')],
'BUSINESS':[turn,('GET','/business/profiles'),('POST','/business/profiles'),('PATCH','/business/profiles/:id'),('POST','/business/profiles/:id/submit'),('GET','/businesses/:id/storefront')],
'STAFF':[('GET','/business/profiles/:id/delegations'),('POST','/business/profiles/:id/delegations'),('POST','/business/profiles/:id/delegations/:delegationId/revoke'),('GET','/business/delegations/:delegationId/catalog'),('GET','/connect/partners/:id/report')],
'FINANCE':[('GET','/seller-dues'),('GET','/orders/:id')],
'PAYMENT':[('POST','/payments/intents'),('POST','/payments/webhooks/test')],
'REFUND':[('POST','/admin/payments/intents/:id/refunds'),('GET','/admin/payments/refund-obligations'),('POST','/admin/payments/reconcile'),('POST','/payments/webhooks/test')],
'CASH':[('POST','/orders/:id/cash-payment/claim'),('POST','/orders/:id/cash-payment/confirm'),('POST','/orders/:id/cash-refunds'),('POST','/cash-refunds/:id/repayment-claim'),('POST','/cash-refunds/:id/confirm')],
'ORDERS':[('GET','/orders'),('GET','/orders/:id'),('POST','/orders/:id/:action')],
'CHECKOUT':[('GET','/cart'),('POST','/checkout'),('GET','/orders/:id')],
'BLOCKE':[turn,('POST','/ai/promotion-actions/:id/action'),('GET','/promotions'),('POST','/promotions/:id/actions'),('PUT','/cart'),('POST','/checkout')],
'PRIVACY':[('GET','/account/privacy'),('GET','/account/privacy/preferences'),('PATCH','/account/privacy/preferences'),('POST','/account/privacy/requests'),('POST','/account/privacy/exports')],
'MEDIA':[('POST','/account/listing-photos/upload-url'),('POST','/account/profile-avatar/upload-url'),('PUT','/account/profile-avatar')],
'LEGAL':[('GET','/markets/:marketId/compliance'),('GET','/account/policy-consents'),('POST','/account/guardian-consent'),('POST','/admin/compliance/country-readiness/:marketId/owner-approval'),('POST','/admin/compliance/country-readiness/:marketId/activate')]
}
internal={'EMPLOYMENT':'Jobs/CV/application logic is in the existing employment service, reached through turns and reviewed employment-action confirmation; no separate public /jobs API is invented.', 'INQUIRY':'Inquiry reads/drafts/sends are existing conversation-runtime and inquiries-service operations; no separate /inquiries HTTP engine is assumed.', 'DOMAIN':'Domain provider adapter is called from the same conversation runtime; this inventory does not invent a separate domain-search endpoint.', 'USAGE':'Reservation/counter/finalization are canonical internal accounting functions; no nonexistent public usage endpoint is asserted.', 'MODEL':'Tools execute within the bounded server model loop; there is no separate model-action HTTP engine.', 'MEMORY':'D17 retrieval/retention/context control is shared internal runtime logic; privacy preference endpoints are existing account operations.'}
for f in a['features']:
 if f['id']not in ops:continue
 endpoints=ops[f['id']];assert all(x in lookup for x in endpoints),(f['id'],[x for x in endpoints if x not in lookup])
 f['apiOperation']='; '.join(method+' '+path for method,path in endpoints)
 f['apiSourceEvidence']=[lookup[x]for x in endpoints]
 if f['id']in internal:f['internalServiceBoundary']=internal[f['id']];f['apiOperation']+='; '+internal[f['id']]
p.write_text(json.dumps(a,indent=2)+'\n');print('Refined actual endpoint/source evidence for',len(ops),'feature rows; no invented HTTP engines.')
