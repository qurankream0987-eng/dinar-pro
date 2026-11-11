/** Test-only safe diagnostics. No query text, credentials, request bodies or contacts. */
import {performance} from 'node:perf_hooks';
export function observePool(pool:any){
 const original=pool.connect;let acquisitions=0,timeouts=0,otherErrors=0,maxLagMs=0,last=performance.now();
 const classify=(e:any)=>{if(!e)return;const timeout=/timeout|timed out/i.test(String(e.message));if(timeout)timeouts++;else otherErrors++;console.log('FOLLOWUP_DB_ACQUIRE_ERROR',JSON.stringify({kind:timeout?'TIMEOUT':'OTHER',code:typeof e.code==='string'?e.code:'NONE'}));};
 pool.connect=function(...args:any[]){acquisitions++;const callback=args[0];if(typeof callback==='function')return original.call(this,(error:any,...rest:any[])=>{classify(error);callback(error,...rest)});return original.apply(this,args).catch((e:any)=>{classify(e);throw e});};
 const timer=setInterval(()=>{const now=performance.now();maxLagMs=Math.max(maxLagMs,now-last-1000);last=now},1000);timer.unref();
 process.once('exit',()=>console.log('FOLLOWUP_POOL_SUMMARY',JSON.stringify({acquisitions,timeouts,otherErrors,maxLagMs:Math.round(maxLagMs),connectionTimeoutMillis:pool.options.connectionTimeoutMillis,max:pool.options.max})));
}
