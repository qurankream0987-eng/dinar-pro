/** Operator-owned declarations, not a claim of provider/live quality verification. No secrets. */
import {z} from 'zod';
const Name=z.string().regex(/^[A-Za-z0-9._:/-]{1,120}$/);
const Profile=z.object({id:Name,revision:z.number().int().min(1),provider:Name,model:Name,capabilities:z.object({toolCalling:z.literal(true),structuredOutput:z.literal('TOOL_SCHEMA'),imageInput:z.boolean(),tokenStreaming:z.literal(false),maxInputChars:z.number().int().min(512).max(200000)}).strict()}).strict();
const Manifest=z.object({schemaVersion:z.literal(1),releaseId:Name,profiles:z.array(Profile).min(1).max(16)}).strict();
export type AIModelProfile=z.infer<typeof Profile>&{releaseId:string;verification:'DECLARED_NOT_LIVE_VERIFIED'};
/** Bind declarations to the already-authorized gateway slot; never override endpoint/key/routing. */
export function resolveModelProfile(env:NodeJS.ProcessEnv,slot:'PRIMARY'|'FALLBACK'|'HEAVY',configuration:{provider:string;requestedModel:string}):AIModelProfile|undefined {
 const selector=slot==='PRIMARY'?'DINAR_AI_PROFILE':`DINAR_AI_${slot}_PROFILE`;
 const raw=env.DINAR_AI_MODEL_PROFILES;
 if(!raw&&!env[selector])return undefined;
 try {
  if(!raw||raw.length>24000)throw new Error();
  const manifest=Manifest.parse(JSON.parse(raw));
  if(new Set(manifest.profiles.map(p=>p.id)).size!==manifest.profiles.length)throw new Error();
  const p=manifest.profiles.find(p=>p.id===env[selector]);
  if(!p||p.provider!==configuration.provider||p.model!==configuration.requestedModel)throw new Error();
  return {...p,releaseId:manifest.releaseId,verification:'DECLARED_NOT_LIVE_VERIFIED'};
 }catch{throw new Error(`Invalid ${selector} model-profile binding; check schema, unique IDs and exact slot identity.`);}
}
