const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const root='/workspace/dinar-next-functional-audit',out='/workspace/dinar-connect-evidence/expanded-driver';fs.mkdirSync(out,{recursive:true});const ts=createRequire(root+'/package.json')('typescript');
const widths=[320,360,375,390,430,768,1024,1440,1600,1920];
for(const [name,label] of [['wave6-2-recovery-browser','label'],['wave63-delivery-journey-browser','name']]){
 const file=root+'/artifacts/dinar/test/'+name+'.mjs',source=fs.readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),changes=[];
 function walk(n){
  if(ts.isImportDeclaration(n)&&n.moduleSpecifier.text==='@playwright/test')changes.push({start:n.getStart(tree),end:n.end,text:`import {createRequire as driverEvidenceRequire} from 'node:module';const {chromium}=driverEvidenceRequire(${JSON.stringify(root+'/artifacts/dinar/package.json')})('@playwright/test');`});
  if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='widths'&&n.initializer)changes.push({start:n.initializer.getStart(tree),end:n.initializer.end,text:JSON.stringify(widths)});
  if(ts.isForOfStatement(n)&&n.initializer.getText(tree)==='const width'&&ts.isBlock(n.statement)){
   const body=n.statement.getText(tree).slice(1,-1),extra=`await page.emulateMedia({colorScheme:scheme});await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});`;
   let augmented=body.replace('await page.setViewportSize({ width, height: 900 });','await page.setViewportSize({ width, height: 900 });'+extra);
   augmented+=`const dark=await page.evaluate(()=>document.documentElement.classList.contains('dark'));assert.equal(dark,scheme==='dark');expandedDriverProfiles.push({width,scheme,label:${label}});if(width===320||width===1920)await page.screenshot({path:process.env.DINAR_DRIVER_EVIDENCE_DIR+'/'+${JSON.stringify(name)}+'-'+${label}.replace(/[^a-zA-Z0-9-]/g,'_')+'-'+width+'-'+scheme+'.png',fullPage:true});`;
   changes.push({start:n.getStart(tree),end:n.end,text:`for(const width of ${JSON.stringify(widths)}){for(const scheme of ['light','dark']){${augmented}}}`});return;
  }
  ts.forEachChild(n,walk);
 }
 walk(tree);let result=source;for(const c of changes.sort((a,b)=>b.start-a.start))result=result.slice(0,c.start)+c.text+result.slice(c.end);
 result='// Canonical driver actions/security assertions, expanded presentation only.\nconst expandedDriverProfiles=[];\n'+result;
 result=result.replace('JSON.stringify({\n    checks,','JSON.stringify({\n    expandedDriverProfiles,\n    checks,').replace('JSON.stringify({\n    status: "PASS",','JSON.stringify({\n    expandedDriverProfiles,\n    status: "PASS",');
 fs.writeFileSync(out+'/'+name+'.mjs',result);
}
let wrapper=fs.readFileSync(root+'/artifacts/api-server/test/block-f4-driver.test.ts','utf8');for(const name of ['wave6-2-recovery-browser','wave63-delivery-journey-browser']){const needle='`${process.cwd()}/../dinar/test/'+name+'.mjs`';if(!wrapper.includes(needle))throw new Error('Canonical browser invocation missing '+name);wrapper=wrapper.replace(needle,JSON.stringify(out+'/'+name+'.mjs'));}
wrapper=wrapper.replace('    childResult = JSON.parse(line.slice("W62_BROWSER_RESULT ".length));','    childResult = JSON.parse(line.slice("W62_BROWSER_RESULT ".length));\n    console.log("EXPANDED_DRIVER_RECOVERY", JSON.stringify(childResult));');
fs.writeFileSync(out+'/driver-entry.ts',wrapper);console.log('Prepared canonical48-case driver wrapper with original geometry/security/action assertions and both themes at all required plus retained widths.');
