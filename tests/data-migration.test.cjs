// [AI-added] 2026-09-17 11:46
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomic}=require('../runtime/core/storage.cjs'),migration=require('../runtime/migrate-data.cjs'),{projectDataRoot}=require('../runtime/core/data-root.cjs');
test('stopped sibling service migrates into the workspace without deleting its source',t=>{
 // Previous implementation used source=path.join(base,'old-service').
 // [AI-added] 2026-09-24 11:16: Model the real retired user-home service path.
 const base=fs.mkdtempSync(path.join(path.resolve(__dirname,'../tmp'),'migration-')),workspace=path.join(base,'project'),home=path.join(base,'home'),source=path.join(home,'.task-dispatch-service'),registry=path.join(base,'registry.json');t.after(()=>fs.rmSync(base,{recursive:true,force:true}));fs.mkdirSync(workspace);fs.mkdirSync(source,{recursive:true});
 const project={id:'p',workspace,tasks:{},bindings:{}};atomic(path.join(source,'config.json'),{version:1});atomic(path.join(source,'state.json'),{version:2,revision:0,projects:{p:project},events:[]});
 const credential=path.join(source,'clients','brain.json');atomic(credential,{clientId:'brain-client',token:crypto.randomBytes(32).toString('hex'),workspace,data:source});atomic(path.join(source,'connections','brain-client.json'),{version:1,workspace,data:source,credential});
 // [AI-added] 2026-09-24 11:10: Copied business JSON and review evidence must stay byte-for-byte immutable.
 const sourceJson=path.join(source,'artifacts','candidate','tree','payload.json'),reviewJson=path.join(source,'reviews','attempt','tree','broken.json');
 fs.mkdirSync(path.dirname(sourceJson),{recursive:true});fs.mkdirSync(path.dirname(reviewJson),{recursive:true});
 fs.writeFileSync(sourceJson,JSON.stringify({literalPath:source}));fs.writeFileSync(reviewJson,'{not-service-metadata');
 const result=migration.apply({from:source},{registryFile:registry}),target=projectDataRoot(workspace);assert.equal(result.workspace,path.resolve(workspace));assert.equal(result.target,target);assert.equal(fs.existsSync(source),true);assert.equal(fs.existsSync(target),true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(target,'clients','brain.json'))).data,target);assert.equal(JSON.parse(fs.readFileSync(path.join(target,'connections','brain-client.json'))).credential,path.join(target,'clients','brain.json'));
 assert.match(fs.readFileSync(path.join(workspace,'.task-dispatch','.gitignore'),'utf8'),/^runtime\/$/m);assert.equal(JSON.parse(fs.readFileSync(registry,'utf8')).services[Object.keys(JSON.parse(fs.readFileSync(registry,'utf8')).services)[0]].root,target);
 // [AI-added] 2026-09-24 11:10: Metadata paths change, but source-tree bytes do not.
 assert.deepEqual(fs.readFileSync(path.join(target,'artifacts','candidate','tree','payload.json')),fs.readFileSync(sourceJson));
 assert.deepEqual(fs.readFileSync(path.join(target,'reviews','attempt','tree','broken.json')),fs.readFileSync(reviewJson));
 // [AI-added] 2026-09-24 11:16: Old invitations cannot recreate the legacy service after migration.
 const roots=require('../runtime/core/data-root.cjs');
 assert.throws(()=>roots.resolveDataRoot({args:['--data',source],workspace,home}),/Project service has moved/);
 // Previous assertion covered a stale context.data override.
 // [AI-added] 2026-09-24 11:17: The original credential itself must be rejected.
 assert.throws(()=>roots.resolveDataRoot({workspace,credentialFile:credential,home}),/Project service has moved/);
 assert.equal(roots.resolveDataRoot({workspace,home}),target);
});
