from pathlib import Path
import subprocess,os,json,time,datetime,re
root=Path('/workspace/dinar-next-functional-audit');base=Path('/workspace/dinar-connect-evidence')
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
assert subprocess.check_output(['git','branch','--show-current'],cwd=root,text=True).strip()=='codex/dinar-next-functional-audit'
out=base/('functional-audit-program-'+sha[:7]);out.mkdir(exist_ok=True)
env={**os.environ,'PATH':'/workspace/onboarding/pgsql/bin:/workspace/onboarding/tools/node_modules/.bin:'+os.environ['PATH']}
def clean():
 assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==sha
 assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
def run(label,args,extra=None,timeout=12000):
 clean();start=time.time();stamp=datetime.datetime.now(datetime.timezone.utc).isoformat();log=out/(label+'.log')
 with log.open('w') as stream:
  result=subprocess.run(args,cwd=root,env={**env,**(extra or {})},stdout=stream,stderr=subprocess.STDOUT,timeout=timeout)
 raw=log.read_text(errors='replace');logical=result.returncode
 for line in raw.splitlines():
  if line.startswith('{'):
   try:
    row=json.loads(line)
    if row.get('exit',0)!=0:logical=logical or 1
   except (ValueError,AttributeError):pass
 record={'phase':label,'sourceSHA':sha,'processExit':result.returncode,'exit':logical,'startedAtUTC':stamp,'finishedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'seconds':round(time.time()-start,2),'log':str(log),'command':args}
 with (out/'phases.jsonl').open('a') as stream:stream.write(json.dumps(record)+'\n')
 print(json.dumps(record),flush=True);clean();return logical
clean();(out/'source-head.txt').write_text(sha+'\n')
for label,args in [('codegen',['pnpm','--filter','@workspace/api-spec','run','codegen']),('generated-drift',['git','diff','--exit-code','--','lib/api-spec','lib/api-zod','lib/api-client-react']),('typecheck',['pnpm','run','typecheck']),('api-build',['pnpm','--filter','@workspace/api-server','run','build']),('web-build',['pnpm','--filter','@workspace/dinar','run','build']),('g33-guards',['node','scripts/ci/g33-local-guards.test.mjs'])]:
 if run(label,args):raise SystemExit('Preflight failed; source preserved, remaining phases not started.')
run('regular-350',['python3',str(base/'run-functional-audit-final-current.py')])
# Docker uses the managed socket and inherited proxy/CA; no publication or deployment.
docker=['env','-u','DOCKER_HOST','-u','DOCKER_CONTEXT','-u','DOCKER_TLS','-u','DOCKER_TLS_VERIFY','-u','DOCKER_CERT_PATH','docker','--host=unix:///var/run/docker.sock']
image='dinar-next-g33:'+sha
if run('g33-image-build',docker+['build','--build-arg','PNPM_VERSION=10.30.3','--secret','id=proxy_ca,src='+os.environ['CODEX_PROXY_CERT'],'-t',image,'.'],timeout=1200)==0:
 for pg in [16,18]:run(f'g33-pg{pg}',['bash','scripts/ci/g33-docker-acceptance.sh'],{'DINAR_LOCAL_G33_ACCEPTANCE':'disposable','G33_APP_IMAGE':image,'G33_POSTGRES_IMAGE':f'postgres:{pg}'},timeout=1200)
# Reuse qualified local harnesses. Copies live outside the application worktree.
def prepare(name,text):
 p=out/name;p.write_text(text.replace('/workspace/dinar-next-unified',str(root)));return p
special=out/'supported-specials';special.mkdir(exist_ok=True)
s=(base/'run-special-supported-final.py').read_text().replace("out=pathlib.Path('/workspace/dinar-connect-evidence/closure-b13372a')",'out=pathlib.Path('+repr(str(special))+')').replace('dinar_test_special_b133','dinar_test_special_'+sha[:7])
p=prepare('supported-specials.py',s);run('supported-specials',['python3',str(p)],timeout=600)
for pg,port in [(16,55416),(18,55433)]:
 dest=out/f'personal-pg{pg}';dest.mkdir(exist_ok=True)
 s=(base/'run-personal-final.py').read_text().replace('/workspace/dinar-connect-evidence/closure-b13372a',str(dest)).replace('[(18,55433),(16,55416)]',repr([(pg,port)])).replace('dinar_test_personal_final_', 'dinar_test_personal_audit_'+sha[:7]+'_')
 p=prepare(f'personal-pg{pg}.py',s);run(f'personal-pg{pg}',['python3',str(p)],timeout=600)
for pg,port,bin in [(16,55416,'/workspace/dinar-completion/pgsql16/bin/'),(18,55433,'/workspace/onboarding/pgsql/bin/')]:
 dest=out/f'backup-pg{pg}';dest.mkdir(exist_ok=True)
 s=(base/'run-backup-restore-rc.py').read_text().replace("out=pathlib.Path('/workspace/dinar-connect-evidence/backup-restore-rc')",'out=pathlib.Path('+repr(str(dest))+')').replace("[(16,55416,'/workspace/dinar-completion/pgsql16/bin/'),(18,55433,'/workspace/onboarding/pgsql/bin/')]",repr([(pg,port,bin)])).replace('dinar_test_rc_backup_', 'dinar_test_audit_backup_'+sha[:7]+'_')
 p=prepare(f'backup-pg{pg}.py',s);run(f'backup-pg{pg}',['python3',str(p)],timeout=900)
for pg,port in [(16,55416),(18,55433)]:
 dest=out/f'search-100k-pg{pg}';dest.mkdir(exist_ok=True)
 s=(base/'run-search-100k-rc.py').read_text().replace("out=base/'search-100k-rc'",'out=pathlib.Path('+repr(str(dest))+')').replace("base/'full-final-c2a8717/results.jsonl'",'base/'+repr('functional-audit-fresh-'+sha[:7]+'/results.jsonl')).replace('[(16,55416),(18,55433)]',repr([(pg,port)])).replace('dinar_test_search100k_rc_', 'dinar_test_search100k_audit_'+sha[:7]+'_')
 p=prepare(f'search-pg{pg}.py',s);run(f'search-100k-pg{pg}',['python3',str(p)],timeout=1200)
clean();rows=[json.loads(x) for x in (out/'phases.jsonl').read_text().splitlines()]
summary={'sourceSHA':sha,'localPhases':len(rows),'passingPhases':sum(x['exit']==0 for x in rows),'failingPhases':sum(x['exit']!=0 for x in rows),'notAProductionReadinessClaim':True};(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary),flush=True)
