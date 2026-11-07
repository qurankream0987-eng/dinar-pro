from pathlib import Path
import subprocess,os,json
b=Path('/workspace/dinar-connect-evidence');root=Path('/workspace/dinar-next-functional-audit');sha=(b/'functional-audit-qualified-source-current.txt').read_text().strip();assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==sha
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
env={**os.environ,'PATH':'/workspace/onboarding/pgsql/bin:/workspace/onboarding/tools/node_modules/.bin:'+os.environ['PATH']}
log=b/('functional-audit-program-'+sha[:7]+'-progress.log')
with log.open('w') as f:result=subprocess.run(['python3',str(b/'run-functional-audit-frozen-program.py')],cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
print(json.dumps({'frozenProgramProcessExit':result.returncode,'sourceSHA':sha}),flush=True)
summary=json.loads((b/('functional-audit-program-'+sha[:7])/'summary.json').read_text());print(json.dumps(summary),flush=True)
if result.returncode or summary['failingPhases']:raise SystemExit('A frozen-program phase failed. Evidence retained; inspect before starting supplemental work.')
for script,directory in [('run-account-ui-evidence-current.py','functional-audit-account-ui-'),('run-expanded-connect-evidence-current.py','functional-audit-expanded-connect-'),('run-expanded-driver-evidence.py','functional-audit-expanded-driver-'),('run-inline-report-evidence.py','functional-audit-inline-report-')]:
 p=subprocess.run(['python3',str(b/script)],cwd=root,env=env)
 rows=[json.loads(x) for x in (b/(directory+sha[:7])/'results.jsonl').read_text().splitlines()]
 print(json.dumps({'supplementalDriver':script,'processExit':p.returncode,'passingGroups':sum(r['exit']==0 for r in rows),'failingGroups':sum(r['exit']!=0 for r in rows),'sourceSHA':sha}),flush=True)
print('CURRENT_CLOSURE_EXECUTION_FINISHED; verify all records and prepare final local handoff; no publication authorized by latest directive.',flush=True)
