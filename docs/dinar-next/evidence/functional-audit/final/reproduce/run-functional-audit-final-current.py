import datetime,shutil,hashlib,os,re,pathlib,subprocess,time,json,threading,concurrent.futures,signal,fnmatch
root=pathlib.Path('/workspace/dinar-next-functional-audit');api=root/'artifacts/api-server';head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip();out=pathlib.Path('/workspace/dinar-connect-evidence')/('functional-audit-fresh-'+head[:7]);out.mkdir(exist_ok=True)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(); assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip(); (out/'source-head.txt').write_text(head+'\n')
old=[json.loads(x) for x in (out/'results.jsonl').read_text().splitlines()] if (out/'results.jsonl').exists() else [];done={(r['pg'],r['suite']) for r in old}; profiles={(r['pg'],r['suite']):r for r in map(json.loads,pathlib.Path('/workspace/dinar-connect-evidence/full-dc1636d/results.jsonl').read_text().splitlines())}
suites=sorted(p.stem for p in (api/'test').glob('*.test.ts'));excluded={'personal-intelligence.test','storage-portability.test','storage-s3-wire.test','live-model-benchmark.test','g33-docker-acceptance.test'}
flags=re.findall(r'^  (BDINAR_\w+):',(api/'test/safe-development-database.ts').read_text(),re.M)
flags=[f'{x}=development' for x in dict.fromkeys(flags) if x not in ['BDINAR_SEED','BDINAR_ACCEPTANCE_FIXTURES']]+['BDINAR_PROMOTIONS_ENABLED=true']
pattern=re.search(r'    (\*browser-journey\*\|.*?)\) return 0', (api/'test/isolation/local-suite.sh').read_text()).group(1).split('|')
locks={s:threading.Lock() for s in suites};seedgate=threading.Lock();resultlock=threading.Lock()
def isbrowser(s):return s=='phase1-acceptance.test' or any(fnmatch.fnmatch(s,p) for p in pattern)
jobs=[(version,port,index,s) for version,port in [(18,55433),(16,55416)] for index,s in enumerate(suites) if s not in excluded and (version,s) not in done]
priority=['phase1-acceptance.test','sc03-browser-journey.test','g3-ui.test','experience-upgrade-acceptance.test','command-e-ui.test','g3-ui.test','sc01-browser-journey.test','next-g1-usage.test','connect-finance-browser-journey.test','block-e-acceptance.test','w06-d16-adversarial.test','wave06-conversation-memory-adversarial.test','w06-d17-retrieval-quality.test','d12-execution-recovery.test','d3a-native-business.test','conversation-router.test','model-native-routing.test','search-sql-foundation.test','g2-smart-conversation.test','w02u3-card-accessibility-browser-journey.test','conversation-stream-recovery-browser-journey.test','conversation-v2-browser-journey.test','financial-state-machine.test','wave07-financial-journal.test','wave08-cash-and-refunds.test','g2-smart-conversation.test','d16-readiness.test','wave06-conversation-memory.test','w02u3-card-performance-browser-journey.test','w02u3-card-accessibility-browser-journey.test']
jobs.sort(key=lambda j:(priority.index(j[-1]) if j[-1] in priority else len(priority),j[0],j[-1]))
for version,port,index,s in jobs:
 log=out/f'pg{version}-{s}.log'
 if log.exists(): log.rename(log.with_suffix('.interrupted.log'))
def run(job):
 version,port,index,suite=job
 with locks[suite]:
  seed='fixtures'
  if suite in ['admin-bootstrap.test','readiness.test','ai-authority-boundary.test','fresh-environment.test']:seed='none'
  if suite in ['pre-switch.test','phase2-commission-acceptance.test']:seed='development'
  db=f'dinar_test_mediafix0711_{version}_{index}'
  if suite=='fresh-environment.test':db=f'dinar_test_fresh_mediafix0711_{version}'
  if suite=='listing-pricing-invariants.test':db=f'dinar_test_blockb_mediafix0711_{version}'
  if suite=='listing-image-publication-acceptance.test':db=f'dinar_test_image_review_mediafix0711_{version}'
  if suite=='market-legal-acceptance.test':db=f'dinar_test_legal_mediafix0711_{version}';seed='none'
  env={**os.environ,'PATH':'/workspace/onboarding/pgsql/bin:/workspace/onboarding/tools/node_modules/.bin:'+os.environ['PATH'],'DINAR_LOCAL_PG':f'postgresql://dinar_cloud@127.0.0.1:{port}','DINAR_SUITE_DB':db,'DINAR_SUITE_SEED':seed,'DINAR_SUITE_RELEASE_MIGRATIONS':'1' if suite=='fresh-environment.test' and version==18 else '0','DINAR_CHROMIUM':'/usr/bin/chromium'}
  flags=profiles[(version,suite)]['flags']
  if not any(x.startswith('BDINAR_PROMOTIONS_ENABLED=') for x in flags):flags=flags+['BDINAR_PROMOTIONS_ENABLED=true']
  args=['sh','test/isolation/local-suite.sh',suite,*flags]
  if suite=='listing-image-publication-acceptance.test':args+=['BDINAR_IMAGE_PUBLICATION_ACCEPTANCE=disposable']
  if suite in ['block-d-acceptance.test','g1-provider.test','g-final.test']:args+=['BDINAR_LOG_SCAN=1']
  start=time.time();log=out/f'pg{version}-{suite}.log'
  with log.open('w') as f:
   with seedgate:
    process=subprocess.Popen(args,cwd=api,env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
    while process.poll() is None:
     if 'LOCAL_SUITE_PRELUDE exit=0' in log.read_text(errors='replace'):break
     if time.time()-start>180:break
     time.sleep(.1)
   try:status=process.wait(timeout=max(1,600-(time.time()-start)))
   except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGTERM);process.wait();status=124
  text=log.read_text(errors='replace');clean=re.sub(r'\x1b\[[0-9;]*m','',text)
  if suite=='experience-upgrade-acceptance.test':
   evidence=out/f'pg{version}-xp-evidence';evidence.mkdir(exist_ok=True);manifest=[]
   for src in pathlib.Path('/tmp/dinar-xp-evidence').rglob('*'):
    if src.is_file() and src.stat().st_mtime>=start:
     relative=src.relative_to('/tmp/dinar-xp-evidence');dest=evidence/relative;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dest);manifest.append({'file':str(relative),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()})
   (evidence/'manifest.json').write_text(json.dumps({'sourceSHA':head,'files':manifest},indent=2)+'\n')
  if isbrowser(suite):
   shots=out/f'pg{version}-{suite}-screenshots';shots.mkdir(exist_ok=True);manifest=[]
   for prefix in pathlib.Path('/tmp').glob('dinar-*'):
    candidates=[prefix] if prefix.is_file() and prefix.suffix=='.png' else prefix.rglob('*.png') if prefix.is_dir() else []
    for src in candidates:
     if src.stat().st_mtime>=start:
      relative=src.relative_to('/tmp');dest=shots/relative;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dest);manifest.append({'file':str(relative),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()})
   (shots/'manifest.json').write_text(json.dumps({'sourceSHA':head,'suite':suite,'pg':version,'files':manifest},indent=2)+'\n')
  record={'pg':version,'suite':suite,'exit':status,'seconds':round(time.time()-start,2),'startedAtUTC':datetime.datetime.fromtimestamp(start,datetime.timezone.utc).isoformat(),'finishedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':head,'log':str(log),'scheduler':'browser-serial / two independent API jobs; seeding serialized','flags':flags}
  for key in ['tests','pass','fail','skipped']:
   v=re.findall(r'(?:ℹ |# )'+key+r' (\d+)',clean);record[key]=int(v[-1]) if v else None
  v=re.findall(r'LOCAL_SUITE suite=.*outbound=(\d+)',clean);record['outbound']=int(v[-1]) if v else None
  with resultlock:
   with (out/'results.jsonl').open('a') as f:f.write(json.dumps(record)+'\n')
   print(json.dumps(record),flush=True)
def browsers():
 for job in jobs:
  if isbrowser(job[-1]):run(job)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
 b=executor.submit(browsers)
 futures=[executor.submit(run,job) for job in jobs if not isbrowser(job[-1])]
 for f in futures:f.result()
 b.result()

assert subprocess.check_output(["git","rev-parse","HEAD"],cwd=root,text=True).strip()==head
assert not subprocess.check_output(["git","status","--porcelain"],cwd=root,text=True).strip()
records=[json.loads(x) for x in (out/"results.jsonl").read_text().splitlines()]
assert len({(r["pg"],r["suite"]) for r in records})==350
summary={"sourceSHA":head,"groups":len(records),"passing":sum(r["exit"]==0 for r in records),"failing":sum(r["exit"]!=0 for r in records),"casePassExecutions":sum(r.get("pass") or 0 for r in records),"caseFailures":sum(r.get("fail") or 0 for r in records),"caseSkips":sum(r.get("skipped") or 0 for r in records)}
(out/"summary.json").write_text(json.dumps(summary,indent=2)+"\n")
print(json.dumps(summary),flush=True)
