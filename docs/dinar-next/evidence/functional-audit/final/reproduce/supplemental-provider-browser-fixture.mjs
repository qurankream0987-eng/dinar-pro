import assert from 'node:assert/strict';
import https from 'node:https';
import {readFileSync} from 'node:fs';
export async function installSupplementalProviderFixture(context,report){
 const port=Number(process.env.DINAR_SUPPLEMENTAL_PROVIDER_TLS_PORT),ca=readFileSync(process.env.DINAR_SUPPLEMENTAL_PROVIDER_TLS_CA);
 assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
 await context.route(/^https:\/\/(?:dash\.cloudflare\.com|browser\.catalog\.partner\.example)\//,async route=>{
  const url=new URL(route.request().url());assert.equal(route.request().method(),'GET');assert.equal(url.protocol,'https:');assert.equal(url.port,'');assert.equal(url.username,'');assert.equal(url.password,'');assert.ok(['dash.cloudflare.com','browser.catalog.partner.example'].includes(url.hostname));
  const response=await new Promise((resolve,reject)=>{
   const request=https.request({hostname:'127.0.0.1',port,path:url.pathname+url.search,method:'GET',headers:{host:url.hostname},servername:url.hostname,ca,rejectUnauthorized:true,agent:false},result=>{const chunks=[];result.on('data',chunk=>chunks.push(chunk));result.on('end',()=>resolve({status:result.statusCode,headers:result.headers,body:Buffer.concat(chunks)}));});
   request.setTimeout(5000,()=>request.destroy(new Error('Local canonical provider fixture timeout')));request.on('error',reject);request.end();
  });
  const headers={...response.headers};for(const key of ['connection','transfer-encoding','keep-alive','content-length'])delete headers[key];
  await route.fulfill({status:response.status,headers,body:response.body});
  (report.providerFixtureRequests??=[]).push({host:url.hostname,path:url.pathname,transport:'canonical loopback TLS fixture, exact CA and SNI verification; browser navigation intercepted after authoritative outbound'});
 });
}
