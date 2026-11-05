import { test } from "node:test";
import assert from "node:assert/strict";
import { UniversalCardSchema } from "@workspace/api-zod/connect";
import { parseComposedSurface } from "@workspace/api-zod/surface-composition";
import { universalCardSurface } from "../../dinar/src/features/ai/universal-card-surface";
const card = UniversalCardSchema.parse({version:1,id:"stored-offer",kind:"EXTERNAL_PRODUCT",commerceMode:"EXTERNAL_REFERRAL",title:"منتج موثق",description:"",providerId:"approved-partner",sourceLabel:"بيانات الصفحة",facts:[],availability:"UNKNOWN",price:null,checkedAt:new Date().toISOString(),externalActions:[{kind:"EXTERNAL_LINK",providerId:"approved-partner",targetId:"stored-offer",intent:"VIEW_ON_PROVIDER",label:"افتح لدى المزوّد"}],disclosure:"الشراء خارج DINAR"});
await test("an external card without a description renders without inventing a subtitle",()=>{
 const surface=universalCardSurface(card,"aaf95aba-fb91-4e7d-974c-e2d1a384438a");assert.ok(parseComposedSurface(surface));
 assert.equal(Object.hasOwn(surface.sections[0],"subtitle"),false);
});
await test("supported long descriptions and facts retain their exact text in supported primitives",()=>{
 const description="د".repeat(700),value="ق".repeat(300);
 const surface=universalCardSurface({...card,description,facts:[{label:"تفصيل المزوّد",value,source:"PROVIDER_RECORD"}]},"aaf95aba-fb91-4e7d-974c-e2d1a384438a");
 assert.ok(parseComposedSurface(surface));assert.ok(surface.sections.some(section=>section.type==="text"&&section.text===description));assert.ok(surface.sections.some(section=>section.type==="text"&&section.text===`تفصيل المزوّد: ${value}`));
});
await test("missing and empty fact values display as unknown without hiding the entire card",()=>{
 const surface=universalCardSurface({...card,facts:[{label:"العلامة",value:null,source:"UNKNOWN"},{label:"رمز",value:"",source:"PROVIDER_RECORD"}]},"aaf95aba-fb91-4e7d-974c-e2d1a384438a");
 assert.ok(parseComposedSurface(surface));const facts=surface.sections.find(section=>section.type==="facts");assert.equal(facts?.type,"facts");if(facts?.type==="facts")assert.ok(facts.rows.slice(0,2).every(row=>row.value==="غير معروف"));
});
await test("displayed money preserves exact minor units at the safe integer boundary",()=>{
 const surface=universalCardSurface({...card,price:{amountMinor:Number.MAX_SAFE_INTEGER,currency:"USD",minorUnitScale:2}},"aaf95aba-fb91-4e7d-974c-e2d1a384438a");
 const facts=surface.sections.find(section=>section.type==="facts");assert.ok(parseComposedSurface(surface));if(facts?.type==="facts")assert.equal(facts.rows.find(row=>row.label==="السعر")?.value,"90071992547409.91 USD");
});
