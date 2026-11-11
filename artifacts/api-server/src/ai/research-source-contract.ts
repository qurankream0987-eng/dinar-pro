/** Offline pre-activation source contract. No provider calls, registry, store, or active model tool. */
import {isIP} from 'node:net';
import {z} from 'zod';
import {redactForModel} from './model-turn';
const Id=z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/);
const Stamp=z.string().datetime({offset:true});
const base={id:Id,title:z.string().min(1).max(300),excerpt:z.string().max(2000),retrievedAt:Stamp,contentHash:z.string().regex(/^[a-f0-9]{64}$/),url:z.string().url().optional()};
const source=z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('INTERNAL_MARKETPLACE'),resultSetId:Id,resourceIds:z.array(Id).min(1).max(20)}).strict(),
 z.object({...base,kind:z.literal('EXTERNAL_WEB'),url:z.string().url(),publishedAt:Stamp.optional()}).strict(),
 z.object({...base,kind:z.literal('APPROVED_KNOWLEDGE'),approvalId:Id,approvalVersion:z.number().int().min(1)}).strict(),
]);
const bundle=z.object({version:z.literal(1),bundleId:Id,actorId:Id,conversationId:Id,marketId:Id,turnId:Id,status:z.enum(['SUCCEEDED','EMPTY','FAILED','TIMEOUT']),sources:z.array(source).max(5)}).strict();
export type ResearchScope={actorId:string;conversationId:string;marketId:string;turnId:string;referencedBundleId?:string;approvedKnowledgeVersions?:Readonly<Record<string,number>>;authorizedInternalResults?:Readonly<Record<string,readonly string[]>>};
export type ResearchIntent='GENERAL'|'CURRENT_INFORMATION'|'ARABIC_RESEARCH'|'MARKETPLACE'|'MIXED_COMPARISON'|'APPROVED_DOCUMENT';
/** A semantic intent from the existing router is a proposal only; this function never dispatches. */
export function planResearchSources(intent:ResearchIntent,policy:{externalEnabled:boolean;knowledgeEnabled:boolean}) {
 if(!['GENERAL','CURRENT_INFORMATION','ARABIC_RESEARCH','MARKETPLACE','MIXED_COMPARISON','APPROVED_DOCUMENT'].includes(intent))throw new Error('Unknown research intent');
 const sources=intent==='GENERAL'?[]:intent==='MARKETPLACE'?['INTERNAL_MARKETPLACE']:intent==='MIXED_COMPARISON'?['INTERNAL_MARKETPLACE','EXTERNAL_WEB']:intent==='APPROVED_DOCUMENT'?['APPROVED_KNOWLEDGE']:['EXTERNAL_WEB'];
 const blocked=(sources.includes('EXTERNAL_WEB')&&!policy.externalEnabled)||(sources.includes('APPROVED_KNOWLEDGE')&&!policy.knowledgeEnabled);
 return {sources,status:!sources.length?'NO_RETRIEVAL':blocked?'BLOCKED_PROVIDER':'PLANNED_NOT_EXECUTED'};
}
/** Conservative query preflight; no memory/profile/history is accepted here. Not a complete PII detector. */
export function publicResearchQuery(raw:unknown):string|null {
 if(typeof raw!=='string'||raw.length>400||!raw.trim())return null;
 if(redactForModel(raw)!==raw||/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:api[_ -]?key|password|secret|token)\s*[:=]/i.test(raw))return null;
 return raw.trim();
}
function safeCitationUrl(value:string):boolean {
 try {
  const u=new URL(value),host=u.hostname.replace(/^\[|\]$/g,'');
  if(u.protocol!=='https:'||u.username||u.password||isIP(host)||!host.includes('.')||/\.(?:localhost|local|internal|test|invalid)$/i.test(host))return false;
  return ![...u.searchParams.keys()].some(k=>/token|secret|password|authorization|api.?key/i.test(k));
 }catch{return false;}
}
/** Syntax/binding check only. A future fetcher must additionally enforce DNS/redirect/SSRF policy. */
export function validateResearchBundle(raw:unknown,scope:ResearchScope) {
 const b=bundle.parse(raw);
 if(b.actorId!==scope.actorId||b.conversationId!==scope.conversationId||b.marketId!==scope.marketId||(b.turnId!==scope.turnId&&b.bundleId!==scope.referencedBundleId))throw new Error('Research source scope mismatch');
 if((b.status!=='SUCCEEDED'&&b.sources.length)||(b.status==='SUCCEEDED'&&!b.sources.length))throw new Error('Research status/source mismatch');
 if(new Set(b.sources.map(s=>s.id)).size!==b.sources.length)throw new Error('Duplicate citation identity');
 const sources=b.sources.map(s=>{
  if(s.url&&!safeCitationUrl(s.url))throw new Error('Unsafe citation URL');
  if(s.kind==='APPROVED_KNOWLEDGE'&&scope.approvedKnowledgeVersions?.[s.approvalId]!==s.approvalVersion)throw new Error('Knowledge approval not validated');
  if(s.kind==='INTERNAL_MARKETPLACE'&&!s.resourceIds.every(id=>scope.authorizedInternalResults?.[s.resultSetId]?.includes(id)))throw new Error('Internal result identity not validated');
  // Defense in depth only: structural authority denial applies to ALL text, including undetected attacks.
  const suspicious=/ignore (?:all|previous|your) (?:rules|instructions)|reveal secrets|mark .* paid|تجاهل.{0,20}(?:التعليمات|القواعد)/iu.test(s.excerpt);
  return {...s,authority:s.kind==='INTERNAL_MARKETPLACE'?'CANONICAL_IDENTITY_ONLY':'UNTRUSTED_EVIDENCE_ONLY',disposition:suspicious?'QUARANTINED':'QUOTED_DATA_ONLY'};
 });
 return {...b,sources};
}
export function validateCitationIds(b:ReturnType<typeof validateResearchBundle>,ids:readonly string[]):boolean {
 return b.status==='SUCCEEDED'&&ids.length>0&&ids.length<=b.sources.length&&new Set(ids).size===ids.length&&ids.every(id=>b.sources.some(s=>s.id===id&&s.disposition!=='QUARANTINED'));
}
