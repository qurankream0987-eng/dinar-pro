import os,subprocess,pathlib,json,time,re
root=pathlib.Path('/workspace/dinar-next-functional-audit');base=pathlib.Path('/workspace/dinar-connect-evidence');out=pathlib.Path('/workspace/dinar-connect-evidence/functional-audit-program-5121c91/search-100k-pg16');out.mkdir(exist_ok=True)
assert len((base/'functional-audit-fresh-5121c91/results.jsonl').read_text().splitlines())==350
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
for pg,port in [(16, 55416)]:
 env={**os.environ,'PATH':'/workspace/onboarding/pgsql/bin:/workspace/onboarding/tools/node_modules/.bin:'+os.environ['PATH'],'DINAR_LOCAL_PG':f'postgresql://dinar_cloud@127.0.0.1:{port}','DINAR_SUITE_DB':f'dinar_test_search100k_audit_5121c91_{pg}','DINAR_SUITE_SEED':'fixtures','DINAR_SUITE_RELEASE_MIGRATIONS':'0'}
 log=out/f'pg{pg}.log';start=time.time()
 with log.open('w') as f:p=subprocess.run(['sh','test/isolation/local-suite.sh','search-sql-performance.test','BDINAR_TEST_DATABASE=development','BDINAR_PROMOTIONS_ENABLED=true','DINAR_SEARCH_BENCH_FULL=1',f'DINAR_SEARCH_BENCH_OUT={out}/pg{pg}-measurements.json'],cwd=root/'artifacts/api-server',env=env,stdout=f,stderr=subprocess.STDOUT,timeout=900)
 clean=re.sub(r'\x1b\[[0-9;]*m','',log.read_text(errors='replace'));r={'pg':pg,'sourceSHA':sha,'exit':p.returncode,'seconds':round(time.time()-start,2),'log':str(log),'scales':[1000,10000,100000],'mode':'synthetic disposable loopback, existing full benchmark'}
 for key in ['tests','pass','fail','skipped']:
  v=re.findall(r'(?:ℹ |# )'+key+r' (\d+)',clean);r[key]=int(v[-1]) if v else None
 v=re.findall(r'LOCAL_SUITE suite=.*outbound=(\d+)',clean);r['outbound']=int(v[-1]) if v else None
 with (out/'results.jsonl').open('a') as f:f.write(json.dumps(r)+'\n')
 print(json.dumps(r),flush=True)
 if p.returncode:raise SystemExit(p.returncode)
