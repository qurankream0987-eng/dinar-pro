import pathlib,subprocess,os,secrets,json,re
r=pathlib.Path('/workspace/dinar-next-functional-audit');api=r/'artifacts/api-server';out=pathlib.Path('/workspace/dinar-connect-evidence/functional-audit-program-5121c91/supported-specials');sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=r,text=True).strip()
for suite in ['storage-portability.test','storage-s3-wire.test','live-model-benchmark.test']:
 log=out/f'special-supported-{suite}.log';net=out/f'special-supported-{suite}-net.log';net.write_text('')
 env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'LANG':'C.UTF-8','NODE_ENV':'development','DATABASE_URL':'postgresql://fixture@127.0.0.1:1/dinar_test_special_5121c91','DINAR_DEV_DATABASE_URL':'postgresql://fixture@127.0.0.1:1/dinar_test_special_5121c91','BDINAR_DISPOSABLE_ACCEPTANCE_DB':'1','BDINAR_DISPOSABLE_TEST_DATABASE':'1','BDINAR_BLOCK_MODEL_CALLS':'1','SESSION_SECRET':secrets.token_hex(32),'NODE_OPTIONS':f'--import=file://{api}/test/isolation/net-guard.mjs','DINAR_ISOLATION_NET_LOG':str(net)}
 command = ['node','test/run-benchmark.mjs',suite] if suite=='live-model-benchmark.test' else ['/workspace/onboarding/tools/node_modules/.bin/pnpm','run','test:'+suite.removesuffix('.test')]
 with log.open('w') as f:p=subprocess.run(command,cwd=api,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=120)
 raw=log.read_text();record={'suite':suite,'sourceSHA':sha,'exit':p.returncode,'outboundBytes':net.stat().st_size}
 for key in ['tests','pass','fail','skipped']:
  v=re.findall(r'(?:ℹ |# )'+key+r' (\d+)',raw);record[key]=int(v[-1]) if v else None
 with (out/'special-supported-results.jsonl').open('a') as f:f.write(json.dumps(record)+'\n')
 print(json.dumps(record),flush=True)
