import asyncio,threading,subprocess,os,pathlib,secrets,json
repo=pathlib.Path('/workspace/dinar-next-unified');api=repo/'artifacts/api-server';dest=55433
pathlib.Path('/workspace/dinar-connect-evidence/closure-b13372a').mkdir(exist_ok=True)
async def handle(reader,writer):
 try:
  remote,output=await asyncio.open_connection('127.0.0.1',dest)
  async def pipe(r,w):
   try:
    while data:=await r.read(65536):w.write(data);await w.drain()
   finally:w.close()
  await asyncio.gather(pipe(reader,output),pipe(remote,writer),return_exceptions=True)
 except Exception:writer.close()
async def serve():
 server=await asyncio.start_server(handle,'127.0.0.1',55479)
 async with server:await server.serve_forever()
threading.Thread(target=lambda:asyncio.run(serve()),daemon=True).start()
pg='/workspace/onboarding/pgsql/bin/'
for version,port in [(18,55433),(16,55416)]:
 dest=port; db=f'dinar_test_personal_final_{version}';url=f'postgresql://dinar_cloud@127.0.0.1:{port}/{db}'
 subprocess.run([pg+'createdb','-h','127.0.0.1','-p',str(port),'-U','dinar_cloud',db],check=True)
 env={'PATH':'/workspace/onboarding/tools/node_modules/.bin:'+os.environ['PATH'],'HOME':os.environ['HOME'],'LANG':'C.UTF-8','NODE_ENV':'development','DATABASE_URL':url,'DINAR_DEV_DATABASE_URL':url,'BDINAR_SEED_PASSWORD':'personal-seed-'+secrets.token_hex(16),'SESSION_SECRET':secrets.token_hex(32),'BDINAR_BLOCK_MODEL_CALLS':'1','BDINAR_DISPOSABLE_ACCEPTANCE_DB':'1','BDINAR_DISPOSABLE_TEST_DATABASE':'1','DINAR_PERSONAL_TEST_DATABASE_URL':f'postgresql://dinar_cloud@127.0.0.1:55479/{db}','DINAR_ISOLATION_NET_LOG':f'/workspace/dinar-connect-evidence/closure-b13372a/personal{version}-net.log','NODE_OPTIONS':f'--import=file://{api}/test/isolation/net-guard.mjs'}
 pathlib.Path(env['DINAR_ISOLATION_NET_LOG']).write_text('')
 log=open(f'/workspace/dinar-connect-evidence/closure-b13372a/personal{version}.log','w')
 try:
  subprocess.run(['node_modules/.bin/drizzle-kit','migrate','--config','./drizzle.config.ts'],cwd=repo/'lib/db',env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
  seed={**env,'BDINAR_ACCEPTANCE_FIXTURES':'development','BDINAR_ACCEPTANCE_FIXTURE_MODULES':'MARKET_FIXTURES,USER_FIXTURES,PRODUCT_LISTINGS,PHASE1_LISTINGS'}
  subprocess.run(['node','--input-type=module','-e', 'import { build } from \'esbuild\'; await build({ entryPoints: [\'test/acceptance-fixtures.seed.ts\'], bundle:true, platform:\'node\', format:\'esm\', outfile:\'.test-build/personal-repairs-isolated-seed.mjs\', external:[\'pg-native\',\'pino\',\'pino-http\'],logLevel:\'warning\',banner:{js:"import { createRequire } from \'node:module\'; const require = createRequire(import.meta.url);"}});'],cwd=api,env=seed,stdout=log,stderr=subprocess.STDOUT,check=True)
  subprocess.run(['node','.test-build/personal-repairs-isolated-seed.mjs'],cwd=api,env=seed,stdout=log,stderr=subprocess.STDOUT,check=True)
  result=subprocess.run(['node','test/run.mjs','personal-intelligence.test'],cwd=api,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180)
  print(json.dumps({'pg':version,'exit':result.returncode,'outbound_bytes':pathlib.Path(env['DINAR_ISOLATION_NET_LOG']).stat().st_size}),flush=True)
 finally:
  log.close();subprocess.run([pg+'dropdb','-h','127.0.0.1','-p',str(port),'-U','dinar_cloud','--force',db],check=True)
