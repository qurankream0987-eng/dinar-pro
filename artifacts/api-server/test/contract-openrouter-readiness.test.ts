/** Local configuration contracts only; these tests never contact an AI provider. */
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {describeAIModelReadiness,resolveAIModelRuntimeConfiguration,resolveAIProviderConfiguration} from '../src/ai/model-gateway';
import {gatewayForTier} from '../src/ai/model-tier';
import {visionEnv} from '../src/ai/visual-search';
import {requireSafeReplitDevelopmentDatabase} from './safe-development-database';
requireSafeReplitDevelopmentDatabase('BDINAR_TEST_DATABASE');
const profile=()=>({NODE_ENV:'production',DINAR_DEPLOYMENT_ENV:'staging',DINAR_AI_PROVIDER:'OPENAI_COMPATIBLE',DINAR_AI_BASE_URL:'https://openrouter.ai/api/v1',DINAR_AI_MODEL:'fixture/text-model',DINAR_AI_API_KEY:'synthetic-primary-only',DINAR_AI_PROVIDER_ORDER:'fixture-provider',DINAR_AI_DATA_COLLECTION:'deny',DINAR_AI_ZDR:'true',DINAR_AI_REQUIRE_PARAMETERS:'true',DINAR_AI_MODEL_FALLBACK:'false'});
test('OR-01 deployable OpenRouter shape is pinned, private, model-specific and disabled',()=>{
 const env=profile(),cfg=resolveAIProviderConfiguration(env),ready=describeAIModelReadiness(env);assert.equal(cfg.provider,'OPENAI_COMPATIBLE');assert.equal(cfg.credentialName,'DINAR_AI_API_KEY');assert.deepEqual(cfg.openRouterRouting,{order:['fixture-provider'],requireParameters:true,dataCollection:'deny',zdr:true});assert.equal(ready.valid,true);if(!ready.valid)return;assert.equal(ready.modelCallsEnabled,false);assert.equal(ready.liveProvidersEnabled,false);assert.ok(!JSON.stringify(ready).includes(env.DINAR_AI_API_KEY));
 for(const bad of [{DINAR_AI_PROVIDER:'OPENROUTER'},{DINAR_AI_MODEL:'openrouter/free'},{DINAR_AI_ZDR:'false'},{DINAR_AI_PROVIDER_ORDER:'a,b'}])assert.throws(()=>resolveAIProviderConfiguration({...env,...bad}));
});
test('OR-02 capability metadata promises tool-schema output and no provider token streaming',()=>{
 const cfg=resolveAIModelRuntimeConfiguration(profile());assert.equal(cfg.capabilities.toolCalling,true);assert.equal(cfg.capabilities.structuredOutput,'TOOL_SCHEMA');assert.equal(cfg.capabilities.tokenStreaming,false);assert.equal(cfg.capabilities.imageInput,false);
});
test('OR-03 OpenRouter cannot silently become same-model high-effort reasoning',()=>{
 const light:any={providerInfo:{provider:'OPENAI_COMPATIBLE',requestedModel:'fixture/light'},proposeToolCall:async()=>{throw new Error('must not be called')}};
 const same=gatewayForTier(light,'HEAVY','high');assert.equal(same.tier,'LIGHT');assert.equal(same.degraded,'HEAVY_UNAVAILABLE');assert.equal(same.reasoningEffort,undefined);
 light.heavy={providerInfo:{provider:'OPENAI_COMPATIBLE',requestedModel:'fixture/heavy'},proposeToolCall:light.proposeToolCall};const distinct=gatewayForTier(light,'HEAVY','high');assert.equal(distinct.tier,'HEAVY');assert.equal(distinct.heavyKind,'SEPARATE_MODEL');assert.equal(distinct.reasoningEffort,undefined);
});
test('OR-04 current heavy credential binding is explicit: HEAVY_API_KEY alone does not configure it',()=>{
 const ready=describeAIModelReadiness({...profile(),DINAR_AI_TIERING:'on',DINAR_AI_HEAVY_PROVIDER:'OPENAI_COMPATIBLE',DINAR_AI_HEAVY_BASE_URL:'https://openrouter.ai/api/v1',DINAR_AI_HEAVY_MODEL:'fixture/heavy',DINAR_AI_HEAVY_API_KEY:'synthetic-unused',DINAR_AI_HEAVY_PROVIDER_ORDER:'fixture-provider',DINAR_AI_HEAVY_DATA_COLLECTION:'deny',DINAR_AI_HEAVY_ZDR:'true',DINAR_AI_HEAVY_REQUIRE_PARAMETERS:'true'});assert.equal(ready.valid,true);if(!ready.valid)return;const heavy:any=ready.tiering?.heavy;assert.equal(heavy.credentialName,'DINAR_AI_FALLBACK_API_KEY');assert.equal(heavy.configured,false);
});
test('OR-05 explicit vision slot excludes text-slot credential and parameters',()=>{
 const mapped=visionEnv({...profile(),DINAR_AI_VISION_PROVIDER:'OPENAI_COMPATIBLE',DINAR_AI_VISION_BASE_URL:'https://openrouter.ai/api/v1',DINAR_AI_VISION_MODEL:'fixture/vision-model',DINAR_AI_VISION_API_KEY:'synthetic-vision-only',DINAR_AI_VISION_PROVIDER_ORDER:'fixture-image-provider',DINAR_AI_VISION_DATA_COLLECTION:'deny',DINAR_AI_VISION_ZDR:'true',DINAR_AI_VISION_REQUIRE_PARAMETERS:'true'});assert.equal(mapped.DINAR_AI_API_KEY,'synthetic-vision-only');assert.equal(mapped.DINAR_AI_MODEL,'fixture/vision-model');assert.equal(mapped.DINAR_AI_IMAGE_INPUT,'true');assert.ok(!Object.values(mapped).includes('synthetic-primary-only'));
});
after(async()=>{await pool.end()});
