from pathlib import Path
import subprocess,os,json,time,re,hashlib
root=Path('/workspace/dinar-next-functional-audit');b=Path('/workspace/dinar-connect-evidence');sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip();assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip();out=b/('functional-audit-expanded-driver-'+sha[:7]);out.mkdir(exist_ok=True)
profiles={r['pg']:r for r in map(json.loads,(b/('functional-audit-fresh-'+sha[:7])/'results.jsonl').read_text().splitlines()) if r['suite']=='block-f4-driver.test'}
for pg,port in [(16,55416),(18,55433)]:
 dest=out/f'pg{pg}';dest.mkdir(exist_ok=True);shots=dest/'screenshots';shots.mkdir(exist_ok=True);start=time.time();env={**os.environ,'PATH':'/workspace/onboarding/pgsql/bin:/workspace/onboarding/tools/node_modules/.bin:'+os.environ['PATH'],'DINAR_LOCAL_PG':f'postgresql://dinar_cloud@127.0.0.1:{port}','DINAR_SUITE_DB':f'dinar_test_driverui_{sha[:7]}_{pg}','DINAR_SUITE_SEED':'fixtures','DINAR_SUITE_RELEASE_MIGRATIONS':'1' if pg==18 else '0','DINAR_CHROMIUM':'/usr/bin/chromium'}
 with (dest/'acceptance.log').open('w') as f:p=subprocess.run(['sh',str(b/'expanded-driver-local-suite.sh'),'block-f4-driver.test',*profiles[pg]['flags'],'DINAR_DRIVER_EVIDENCE_DIR='+str(shots)],cwd=root/'artifacts/api-server',env=env,stdout=f,stderr=subprocess.STDOUT,timeout=600)
 raw=re.sub(r'\x1b\[[0-9;]*m','',(dest/'acceptance.log').read_text());record={'pg':pg,'sourceSHA':sha,'exit':p.returncode,'seconds':round(time.time()-start,2),'mode':'canonical driver/API actions and assertions; supplemental required width/theme geometry only; unchanged application/test source'}
 netproof=re.findall(r'LOCAL_SUITE suite=.*outbound=(\d+)',raw);record['outbound']=int(netproof[-1])if netproof else None
 if record['outbound']!=0:record['exit']=record['exit'] or 1
 for key in ['tests','pass','fail','skipped']:
  values=re.findall(r'(?:ℹ |# )'+key+r' (\d+)',raw);record[key]=int(values[-1]) if values else None
 for marker in ['EXPANDED_DRIVER_RECOVERY','W63-17_SIGNED_BROWSER']:
  found=re.findall(marker+r' (.*)',raw)
  if found:
   report=json.loads(found[-1]);(dest/(marker+'.json')).write_text(json.dumps(report,indent=2)+'\n');record[marker+'Profiles']=len(report.get('expandedDriverProfiles',[]))
 (dest/'screenshots-sha256.json').write_text(json.dumps({x.name:hashlib.sha256(x.read_bytes()).hexdigest() for x in shots.glob('*.png')},indent=2)+'\n')
 with (out/'results.jsonl').open('a') as f:f.write(json.dumps(record)+'\n')
 print(json.dumps(record),flush=True)
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==sha
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
