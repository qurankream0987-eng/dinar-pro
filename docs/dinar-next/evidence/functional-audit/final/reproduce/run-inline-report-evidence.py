from pathlib import Path
import subprocess,os,json,re,time,hashlib
root=Path('/workspace/dinar-next-functional-audit');b=Path('/workspace/dinar-connect-evidence');sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip();assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip();out=b/('functional-audit-inline-report-'+sha[:7]);out.mkdir(exist_ok=True);profiles={r['pg']:r for r in map(json.loads,(b/('functional-audit-fresh-'+sha[:7])/'results.jsonl').read_text().splitlines()) if r['suite']=='sc01-browser-journey.test'}
for pg,port in [(16,55416),(18,55433)]:
 dest=out/f'pg{pg}';dest.mkdir(exist_ok=True);shots=dest/'screenshots';shots.mkdir(exist_ok=True);start=time.time();env={**os.environ,'PATH':'/workspace/onboarding/pgsql/bin:/workspace/onboarding/tools/node_modules/.bin:'+os.environ['PATH'],'DINAR_LOCAL_PG':f'postgresql://dinar_cloud@127.0.0.1:{port}','DINAR_SUITE_DB':f'dinar_test_trustui_{sha[:7]}_{pg}','DINAR_SUITE_SEED':'fixtures','DINAR_SUITE_RELEASE_MIGRATIONS':'1' if pg==18 else '0','DINAR_CHROMIUM':'/usr/bin/chromium'}
 with (dest/'acceptance.log').open('w') as f:p=subprocess.run(['sh',str(b/'inline-report-local-suite.sh'),'sc01-browser-journey.test',*profiles[pg]['flags'],'DINAR_TRUST_EVIDENCE_DIR='+str(shots)],cwd=root/'artifacts/api-server',env=env,stdout=f,stderr=subprocess.STDOUT,timeout=600)
 raw=re.sub(r'\x1b\[[0-9;]*m','',(dest/'acceptance.log').read_text());record={'pg':pg,'sourceSHA':sha,'exit':p.returncode,'seconds':round(time.time()-start,2),'mode':'canonical SC01 actual commerce plus additional shipped inline listing report; no App.tsx override'}
 netproof=re.findall(r'LOCAL_SUITE suite=.*outbound=(\d+)',raw);record['outbound']=int(netproof[-1])if netproof else None
 if record['outbound']!=0:record['exit']=record['exit'] or 1
 for key in ['tests','pass','fail','skipped']:
  found=re.findall(r'(?:ℹ |# )'+key+r' (\d+)',raw);record[key]=int(found[-1]) if found else None
 reports=re.findall(r'SC01_BROWSER (.*)',raw)
 if reports:
  report=json.loads(reports[-1]);(dest/'browser-report.json').write_text(json.dumps(report,indent=2)+'\n');record['reportProfiles']=len(report.get('trustReport',{}).get('profiles',[]))
 with (out/'results.jsonl').open('a') as f:f.write(json.dumps(record)+'\n')
 print(json.dumps(record),flush=True)
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
