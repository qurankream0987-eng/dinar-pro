/** Independent current-contract equivalence; historical golden assertions remain untouched. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '@workspace/db';
import { marketFor } from '../src/lib/markets';
import { searchMarketplaceListings } from '../src/lib/marketplace-listings';
import { refreshSearchDocuments, staleSearchDocumentCount } from '../src/lib/marketplace-search-index';
import { LISTINGS, QUERIES, resultShape, seedSearchFixture } from './search-fixture';
import { requireSafeReplitDevelopmentDatabase } from './safe-development-database';
requireSafeReplitDevelopmentDatabase('BDINAR_TEST_DATABASE');
process.env.BDINAR_PROMOTIONS_ENABLED='true';
await seedSearchFixture();
const market=await marketFor({actor:{activeMarketId:'JO'}});
async function run(engine:'SQL'|'LEGACY') {
 process.env.DINAR_SEARCH_ENGINE=engine;const rows=[];
 for(const options of QUERIES){try{
  const result=resultShape(await searchMarketplaceListings(market,options as any));
  const full=resultShape(await searchMarketplaceListings(market,{...(options as any),limit:100000})).map(row=>row.slice(0,4)).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  rows.push({options,result,full});
 }catch(error){rows.push({options,error:(error as Error).message});}}
 return rows;
}
await test('all caller-shaped queries agree between stale SQL, refreshed SQL and current authoritative legacy semantics',async()=>{
 assert.ok((await staleSearchDocumentCount('JO'))>=LISTINGS.length);
 const legacy=await run('LEGACY');assert.equal(legacy.length,QUERIES.length);
 assert.deepEqual(await run('SQL'),legacy,'stale SQL must equal current legacy including exact identities, prices, ordering and paid labels');
 while((await refreshSearchDocuments({limit:500})).refreshed>0){}
 assert.equal(await staleSearchDocumentCount('JO'),0);
 assert.deepEqual(await run('SQL'),legacy,'fresh SQL must equal the same authoritative results');
});
after(async()=>{delete process.env.DINAR_SEARCH_ENGINE;await pool.end();});
