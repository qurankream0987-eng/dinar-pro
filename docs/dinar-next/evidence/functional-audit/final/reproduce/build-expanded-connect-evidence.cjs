const fs=require('node:fs');const path=require('node:path');const {createRequire}=require('node:module');
const root='/workspace/dinar-next-functional-audit',out='/workspace/dinar-connect-evidence/expanded-connect';fs.mkdirSync(out,{recursive:true});
const ts=createRequire(root+'/package.json')('typescript'),widths=[320,360,390,430,768,1024,1280,1440,1920];
function apply(source,changes){for(const c of changes.sort((a,b)=>b.start-a.start))source=source.slice(0,c.start)+c.text+source.slice(c.end);return source;}
for(const name of ['connect-cards','connect-finance']){
 const file=root+'/artifacts/dinar/test/'+name+'-ui.mjs',source=fs.readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),changes=[];let loops=0;
 function walk(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='context'&&ts.isAwaitExpression(node.initializer)&&ts.isCallExpression(node.initializer.expression)&&node.initializer.expression.expression.getText(tree)==='browser.newContext'){
   const statement=node.parent.parent;changes.push({start:statement.end,end:statement.end,text:'await installSupplementalProviderFixture(context,report);'});
  }
  if(ts.isImportDeclaration(node)&&node.moduleSpecifier.text==='@playwright/test'){
   const bindings=node.importClause.namedBindings.elements.map(e=>e.name.text).join(',');changes.push({start:node.getStart(tree),end:node.end,text:`import {createRequire as supplementalRequire} from 'node:module'; const {${bindings}}=supplementalRequire(${JSON.stringify(root+'/artifacts/dinar/package.json')})('@playwright/test');`});
  }
  if(ts.isForOfStatement(node)&&ts.isVariableDeclarationList(node.initializer)&&node.initializer.declarations[0].name.getText(tree)==='width'&&ts.isBlock(node.statement)){
   let page;
   function find(n){if(!page&&ts.isCallExpression(n)&&n.expression.getText(tree)==='resize')page=n.arguments[0].getText(tree);ts.forEachChild(n,find);}
   find(node.statement);if(!page)throw new Error('Unreviewed width loop in '+name);
   let body=node.statement.getText(tree).slice(1,-1).replaceAll('${width}.png','${width}-${scheme}.png');
   body=body.replace(/\.screenshot\(\{\s*path:/g,`.screenshot({mask:[${page}.locator('input[type=\"password\"],code,pre')],path:`);
   const extra=`const layout=await ${page}.evaluate(()=>({dir:document.documentElement.dir,dark:document.documentElement.classList.contains('dark'),overflow:document.documentElement.scrollWidth-innerWidth}));assert.equal(layout.dir,'rtl');assert.equal(layout.dark,scheme==='dark');assert.equal(layout.overflow,0);(report.expandedProfiles??=[]).push({width,scheme,screen:${JSON.stringify(page)},...layout});`;
   changes.push({start:node.getStart(tree),end:node.end,text:`for(const width of ${JSON.stringify(widths)}){for(const scheme of ['light','dark']){await ${page}.emulateMedia({colorScheme:scheme});${body}\n${extra}}}`});loops++;return;
  }
  ts.forEachChild(node,walk);
 }
 walk(tree);if(!loops)throw new Error('No reviewed width loops found');
 const browser=out+'/'+name+'-ui.mjs';fs.writeFileSync(browser,'// Supplemental required-width/theme coverage. Original service/action assertions preserved.\nimport {installSupplementalProviderFixture} from '+JSON.stringify('/workspace/dinar-connect-evidence/supplemental-provider-browser-fixture.mjs')+';\n'+apply(source,changes));
 const wrapper=root+'/artifacts/api-server/test/'+name+'-browser-journey.test.ts',ws=fs.readFileSync(wrapper,'utf8'),wt=ts.createSourceFile(wrapper,ws,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),wc=[];
 function wrap(n){
  if(ts.isBinaryExpression(n)&&n.getText(wt).includes('/../dinar/test/'+name+'-ui.mjs')&&ts.isStringLiteral(n.right)){
   wc.push({start:n.getStart(wt),end:n.end,text:JSON.stringify(browser)});return;
  }
  if(ts.isCallExpression(n)&&n.expression.getText(wt)==='assert.deepEqual'&&n.arguments[0]?.getText(wt)==='report.widths'){
   wc.push({start:n.arguments[1].getStart(wt),end:n.arguments[1].end,text:JSON.stringify(widths.flatMap(x=>[x,x]))});
  }
  ts.forEachChild(n,wrap);
 }
 wrap(wt);if(wc.length!==2)throw new Error('Unexpected wrapper rewrite shape: '+name+' '+wc.length);
 fs.writeFileSync(out+'/'+name+'-entry.ts','// Canonical acceptance + expanded widths/themes only.\n'+apply(ws,wc));console.log(JSON.stringify({name,expandedScreens:loops,profiles:loops*widths.length*2}));
}
