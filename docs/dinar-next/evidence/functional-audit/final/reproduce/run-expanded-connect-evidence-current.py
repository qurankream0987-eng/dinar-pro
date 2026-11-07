from local_navigation_fixture import local_navigation_fixture
from pathlib import Path
import os,subprocess,json,secrets,time,re
root=Path('/workspace/dinar-next-functional-audit');api=root/'artifacts/api-server';base=Path('/workspace/dinar-connect-evidence');sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip();assert sha==(Path('/workspace/dinar-connect-evidence/functional-audit-qualified-source-current.txt').read_text().strip());assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
out=base/('functional-audit-expanded-connect-'+sha[:7]);out.mkdir(exist_ok=True);path='/workspace/onboarding/pgsql/bin:/workspace/onboarding/tools/node_modules/.bin:'+os.environ['PATH'];profiles={(r['pg'],r['suite']):r for r in map(json.loads,(base/('functional-audit-fresh-'+sha[:7])/'results.jsonl').read_text().splitlines())}
buildcode='''import {build} from "esbuild";import {readFile} from "node:fs/promises";await build({stdin:{loader:"ts",contents:await readFile(process.argv[1],"utf8"),resolveDir:process.cwd()+"/test",sourcefile:"expanded-connect-entry.ts"},bundle:true,platform:"node",format:"esm",outfile:process.argv[2],external:["pg-native","pino","pino-http"],logLevel:"warning",banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});'''
for kind in ['connect-cards','connect-finance']:
 for pg,port in [(16,55416),(18,55433)]:
  db=f'dinar_test_uiexpand_{sha[:7]}_{pg}_{kind.split("-")[1]}';url=f'postgresql://dinar_cloud@127.0.0.1:{port}/{db}';dest=out/f'pg{pg}-{kind}';dest.mkdir(exist_ok=True);start=time.time()
  try:
   bootstrap={**os.environ,'PATH':path,'PGPASSFILE':'/dev/null','DINAR_LOCAL_PG':f'postgresql://dinar_cloud@127.0.0.1:{port}','DINAR_SUITE_DB':db,'DINAR_SUITE_SEED':'fixtures','DINAR_SUITE_KEEP_DB':'1','DINAR_SUITE_RELEASE_MIGRATIONS':'1' if pg==18 else '0'}
   with (dest/'bootstrap.log').open('w') as stream:subprocess.run(['sh','test/isolation/local-suite.sh','ai-provider.test',*profiles[(pg,'ai-provider.test')]['flags']],cwd=api,env=bootstrap,stdout=stream,stderr=subprocess.STDOUT,check=True,timeout=300)
   net=dest/'network.log';net.write_text('');flags=dict(item.split('=',1) for item in profiles[(pg,kind+'-browser-journey.test')]['flags']);env={'PATH':path,'HOME':os.environ['HOME'],'LANG':'C.UTF-8','NODE_ENV':'development','DATABASE_URL':url,'DINAR_DEV_DATABASE_URL':url,'BDINAR_DISPOSABLE_ACCEPTANCE_DB':'1','BDINAR_DISPOSABLE_TEST_DATABASE':'1',**flags,'BDINAR_BLOCK_MODEL_CALLS':'1','SESSION_SECRET':secrets.token_hex(32),'NODE_OPTIONS':f'--import=file://{api}/test/isolation/net-guard.mjs','DINAR_ISOLATION_NET_LOG':str(net),'CHROMIUM_PATH':'/usr/bin/chromium','DINAR_CHROMIUM':'/usr/bin/chromium'}
   bundle=api/f'.test-build/expanded-{kind}-{pg}.mjs'
   with (dest/'compile.log').open('w') as stream:subprocess.run(['node','--input-type=module','-e',buildcode,str(base/f'expanded-connect/{kind}-entry.ts'),str(bundle)],cwd=api,env=env,stdout=stream,stderr=subprocess.STDOUT,check=True,timeout=120)
   with local_navigation_fixture(dest,api,path) as nav:
    env.update(nav)
    with (dest/'acceptance.log').open('w') as stream:p=subprocess.run(['node',str(bundle)],cwd=api,env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=600)
   raw=(dest/'acceptance.log').read_text(errors='replace');clean=re.sub(r'\x1b\[[0-9;]*m','',raw);record={'pg':pg,'suite':kind,'sourceSHA':sha,'exit':p.returncode,'seconds':round(time.time()-start,2),'outboundBytes':net.stat().st_size,'requiredWidths':[320,360,390,430,768,1024,1440,1920],'retainedPreviousWidth':1280,'themes':['light','dark'],'mode':'canonical acceptance/actions with expanded presentation matrix only; application and canonical test tree unchanged'}
   for key in ['tests','pass','fail','skipped']:
    v=re.findall(r'(?:ℹ |# )'+key+r' (\d+)',clean);record[key]=int(v[-1]) if v else None
   marker='CONNECT_FINANCE_BROWSER' if kind=='connect-finance' else 'CONNECT_BROWSER';reports=re.findall(marker+r' (.*)',clean)
   if reports:
    report=json.loads(reports[-1]);(dest/'browser-report.json').write_text(json.dumps(report,indent=2)+'\n');record['profiles']=len(report.get('expandedProfiles',[]))
   with (out/'results.jsonl').open('a') as stream:stream.write(json.dumps(record)+'\n')
   print(json.dumps(record),flush=True)
  finally:subprocess.run(['/workspace/onboarding/pgsql/bin/dropdb','-h','127.0.0.1','-p',str(port),'-U','dinar_cloud','--force','--if-exists',db],capture_output=True)
