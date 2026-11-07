const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const root='/workspace/dinar-next-functional-audit';
const ts=createRequire(path.join(root,'package.json'))('typescript');
const files=execFileSync('rg',['--files','artifacts/dinar/src','-g','*.tsx'],{cwd:root,encoding:'utf8'}).trim().split('\n');
const rows=[]; const routes=[];
for (const file of files){
 const code=fs.readFileSync(path.join(root,file),'utf8');
 const tree=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 function walk(node){
  if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)){
   const tag=node.tagName.getText(tree);
   if(tag==='Route'){
     const attribute=node.attributes.properties.find(a=>ts.isJsxAttribute(a)&&a.name.getText(tree)==='path');
     const loc=tree.getLineAndCharacterOfPosition(node.getStart(tree));
     routes.push({file,line:loc.line+1,path:attribute?.initializer?.getText(tree)??null,scope:file.endsWith('/App.tsx')?'TOP_LEVEL_CONDITIONAL_ROUTE':'COMPONENT_ROUTER; verify memoryLocation context'});
   }
   if(/(?:^button$|^a$|Button$|Trigger$|ListRow$|^form$|^Form$|^select$|^input$|Checkbox$|Switch$|^textarea$)/.test(tag)){
    const attributes={};let spread=false;
    for(const a of node.attributes.properties){if(ts.isJsxSpreadAttribute(a)){spread=true;continue;}attributes[a.name.getText(tree)]=a.initializer?.getText(tree).slice(0,240)??true;}
    let form=false,ancestor=node.parent;
    while(ancestor){if(ts.isJsxElement(ancestor)&&/^(form|Form)$/.test(ancestor.openingElement.tagName.getText(tree)))form=true;ancestor=ancestor.parent;}
    const loc=tree.getLineAndCharacterOfPosition(node.getStart(tree));
    rows.push({file,line:loc.line+1,tag,attributes,spread,insideLexicalForm:form,classification:'SOURCE_DECLARATION_ONLY; mounted behavior and forwarding require review'});
   }
  }
  ts.forEachChild(node,walk);
 }
 walk(tree);
}
const out={routes,sourceSHA:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),files:files.length,controls:rows.length,notes:['Includes inactive components; declaration is not an exposed feature or a PASS.','Compound trigger/slot wrappers may legitimately forward handlers.','Values are source expressions, never runtime form contents.'],rows};
fs.writeFileSync('/workspace/dinar-connect-evidence/functional-audit-ui-control-declarations.json',JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({tsxFiles:out.files,controlDeclarations:rows.length}));
