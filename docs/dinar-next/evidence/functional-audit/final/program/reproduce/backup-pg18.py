import subprocess, pathlib, os, json, hashlib, time, tempfile, re, shutil
root=pathlib.Path('/workspace/dinar-next-functional-audit'); api=root/'artifacts/api-server'; out=pathlib.Path('/workspace/dinar-connect-evidence/functional-audit-program-5121c91/backup-pg18');out.mkdir(exist_ok=True)
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
base={'PATH':'/workspace/onboarding/pgsql/bin:/workspace/onboarding/tools/node_modules/.bin:'+os.environ['PATH'],'HOME':os.environ['HOME'],'LANG':'C.UTF-8','TZ':'UTC','PGPASSFILE':'/dev/null','PGCONNECT_TIMEOUT':'3'}
def psql(bin,port,db,query):
 p=subprocess.run([bin+'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h','127.0.0.1','-p',str(port),'-U','dinar_cloud','-d',db,'-c',query],env=base,capture_output=True,text=True)
 if p.returncode:raise RuntimeError('disposable SQL check failed: '+p.stderr.strip())
 return p.stdout.strip()
def digest(bin,port,db):
 tables=json.loads(psql(bin,port,db,"SELECT json_agg(json_build_array(schemaname,tablename) ORDER BY schemaname,tablename) FROM pg_tables WHERE schemaname IN ('public','drizzle')")); result={}
 for schema,table in tables:
  name='"'+schema.replace('"','""')+'"."'+table.replace('"','""')+'"'
  result[schema+'.'+table]=json.loads(psql(bin,port,db,"SELECT json_build_object('rows',count(*),'md5',md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text)) FROM "+name+' t'))
 return result
for ver,port,bin in [(18, 55433, '/workspace/onboarding/pgsql/bin/')]:
 suffix=str(int(time.time())); source=f'dinar_test_audit_backup_5121c91_{ver}_{suffix}';target=source+'_restored'; temp=pathlib.Path(tempfile.mkdtemp(prefix='dinar-rc-backup-',dir='/tmp'));started=time.time();log=out/f'pg{ver}.log'; created_target=False
 try:
  env={**base,'DINAR_LOCAL_PG':f'postgresql://dinar_cloud@127.0.0.1:{port}','DINAR_SUITE_DB':source,'DINAR_SUITE_SEED':'fixtures','DINAR_SUITE_KEEP_DB':'1','DINAR_SUITE_RELEASE_MIGRATIONS':'1' if ver==18 else '0'}
  with log.open('w') as f:
   p=subprocess.run(['sh','test/isolation/local-suite.sh','financial-state-machine.test','wave07-financial-journal.test','BDINAR_WAVE4_ACCEPTANCE=development','BDINAR_W07_ACCEPTANCE=development','BDINAR_TEST_DATABASE=development','BDINAR_PROMOTIONS_ENABLED=true'],cwd=api,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=300)
   assert p.returncode==0,'canonical synthetic finance source acceptance failed; retained log'
   archive=temp/'synthetic.dump';subprocess.run([bin+'pg_dump','-h','127.0.0.1','-p',str(port),'-U','dinar_cloud','--format=custom','--no-owner','--no-acl','--file',str(archive),source],env=base,stdout=f,stderr=subprocess.STDOUT,check=True)
   subprocess.run([bin+'createdb','-h','127.0.0.1','-p',str(port),'-U','dinar_cloud',target],env=base,stdout=f,stderr=subprocess.STDOUT,check=True);created_target=True
   subprocess.run([bin+'pg_restore','-h','127.0.0.1','-p',str(port),'-U','dinar_cloud','--dbname',target,'--no-owner','--no-privileges','--single-transaction','--exit-on-error',str(archive)],env=base,stdout=f,stderr=subprocess.STDOUT,check=True)
  before=digest(bin,port,source);after=digest(bin,port,target);assert before==after,'restored table contents differ'
  for table in ['public.orders','public.order_items','public.order_financial_events']:assert before[table]['rows']>0,table+' must contain real canonical synthetic effects'
  protected=int(psql(bin,port,target,'SELECT count(*) FROM orders WHERE order_line_integrity_version=1'));assert protected>0
  protected_items=int(psql(bin,port,target,'SELECT count(*) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_line_integrity_version=1'));assert protected_items>0
  diagnostic={'allTableDigestsEqual':True,'protectedCanonicalOrders':protected,'protectedCanonicalItems':protected_items,'unqualifiedProbeVersion':psql(bin,port,target,'SELECT order_line_integrity_version FROM orders LIMIT 1')}
  with log.open('a') as f:f.write('RESTORE_DIAGNOSTIC '+json.dumps(diagnostic)+'\n')
  guards={}
  for label,sql in [('order_snapshot','UPDATE orders SET subtotal_minor=subtotal_minor+1 WHERE id=(SELECT id FROM orders WHERE order_line_integrity_version=1 LIMIT 1)'),('order_items','UPDATE order_items SET unit_price_minor=unit_price_minor+1 WHERE id=(SELECT oi.id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_line_integrity_version=1 LIMIT 1)'),('journal','UPDATE order_financial_events SET id=id WHERE id=(SELECT id FROM order_financial_events LIMIT 1)')]:
   p=subprocess.run([bin+'psql','-X','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h','127.0.0.1','-p',str(port),'-U','dinar_cloud','-d',target,'-c','BEGIN; '+sql+'; ROLLBACK;'],env=base,capture_output=True,text=True);expected={'order_snapshot':('P0001','Order price and identity snapshot is immutable','bdinar_order_snapshot_immutable'),'order_items':('55000','Order items are immutable after checkout','dinar_reject_order_item_mutation'),'journal':('23514','order_financial_events is append-only','order_financial_events_guard')}[label];assert p.returncode!=0 and all(part in p.stderr for part in expected),(label,'exact restored invariant was not exercised',p.returncode,p.stderr);guards[label]={'status':'REJECTED_WITH_EXACT_INVARIANT','sqlstate':expected[0],'message':expected[1],'function':expected[2]}
  assert digest(bin,port,target)==after,'negative writes changed restored data'
  record={'pg':ver,'sourceSHA':sha,'exit':0,'mode':'DISPOSABLE_LOOPBACK','migrationMode':'release-manifest PG18' if ver==18 else 'reviewed SQL/Drizzle PG16 compatibility','tables':before,'allTableDigestsEqual':True,'restoredFinancialGuards':guards,'dumpSHA256':hashlib.sha256(archive.read_bytes()).hexdigest(),'seconds':round(time.time()-started,2),'dumpRetained':False}
  (out/f'pg{ver}-result.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps({k:v for k,v in record.items() if k!='tables'}),flush=True)
 finally:
  if created_target:subprocess.run([bin+'dropdb','-h','127.0.0.1','-p',str(port),'-U','dinar_cloud','--force',target],env=base,capture_output=True)
  subprocess.run([bin+'dropdb','-h','127.0.0.1','-p',str(port),'-U','dinar_cloud','--force','--if-exists',source],env=base,capture_output=True)
  shutil.rmtree(temp)
