// [AI-added] 2026-09-17 11:46
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const roots=require('./core/data-root.cjs'),registry=require('./core/service-registry.cjs');
const {read,atomic,plainDirectory}=require('./core/storage.cjs');
function args(values){const option=name=>{const i=values.indexOf(name);if(i<0)return undefined;if(!values[i+1])throw Error(name+' requires a value');return values[i+1];};return {workspace:option('--workspace'),from:option('--from'),apply:values.includes('--apply')};}
function preview(input){
 const source=path.resolve(input.from);
 if(!fs.existsSync(path.join(source,'state.json'))||!fs.existsSync(path.join(source,'config.json')))throw Error('Source is not a task-dispatch service directory');
 if(registry.online(source)||fs.existsSync(path.join(source,'service.lock')))throw Error('Stop the source service and remove only a verified stale lock before migration');
 const state=read(path.join(source,'state.json')),projects=Object.values(state.projects||{});
 const workspaces=[...new Set(projects.map(project=>typeof project.workspace==='string'?path.resolve(project.workspace):null).filter(Boolean))];
 if(workspaces.length!==1)throw Error('Source contains another or unknown workspace; migration must be one project per service');
 const workspace=plainDirectory(input.workspace||workspaces[0]),target=roots.projectDataRoot(workspace);
 if(input.workspace&&path.resolve(input.workspace)!==workspaces[0])throw Error('Explicit workspace does not match the source project');
 if(source===target)throw Error('Source already is the workspace-local data root');
 if(fs.existsSync(target))throw Error('Target already exists; migration will not merge or overwrite it');
 return {workspace,source,target,projectIds:projects.map(project=>project.id),applyRequired:true,sourcePreserved:true};
}
function replacePaths(value,source,target){
 if(typeof value==='string')return value===source||value.startsWith(source+path.sep)?target+value.slice(source.length):value;
 if(Array.isArray(value))return value.map(item=>replacePaths(item,source,target));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replacePaths(item,source,target)]));
 return value;
}
function digest(root){const hash=crypto.createHash('sha256');const walk=(dir,prefix='')=>{for(const name of fs.readdirSync(dir).sort()){if(['service.lock','endpoint.json'].includes(name)&&!prefix)continue;const file=path.join(dir,name),relative=prefix+name,st=fs.lstatSync(file);if(st.isSymbolicLink())throw Error('Migration refuses link: '+relative);if(st.isDirectory())walk(file,relative+'/');else if(st.isFile()){hash.update(relative);hash.update(fs.readFileSync(file));}}};walk(root);return hash.digest('hex');}
function apply(input,options={}){
 const plan=preview(input),parent=path.dirname(plan.target),staging=plan.target+'.migration-'+crypto.randomUUID();fs.mkdirSync(parent,{recursive:true,mode:0o700});
 try{
  fs.cpSync(plan.source,staging,{recursive:true,errorOnExist:true,force:false});
  if(digest(plan.source)!==digest(staging))throw Error('Copied service data failed integrity verification');
  // Previous implementation: for(const file of allJson(staging)){const value=read(file),updated=replacePaths(value,plan.source,plan.target);atomic(file,updated);}
  // [AI-added] 2026-09-24 11:10: Snapshot and review trees are immutable evidence; only
  // service metadata may be rewritten to the new root during migration.
  for(const file of metadataJson(staging)){const value=read(file),updated=replacePaths(value,plan.source,plan.target);atomic(file,updated);}
  for(const name of ['service.lock','endpoint.json']){const file=path.join(staging,name);if(fs.existsSync(file))fs.unlinkSync(file);}
  fs.renameSync(staging,plan.target);roots.ensureProjectLayout(plan.workspace,plan.target);
  registry.register(plan.target,[plan.workspace],options.registryFile?{file:options.registryFile}:{});
  return {...plan,migrated:true,message:'Migration completed; source was preserved and must be removed manually only after the new service is verified.'};
 }catch(error){
  if(!roots.inside(parent,staging)||path.resolve(staging)===path.resolve(parent))throw Error('Unsafe migration staging path; manual inspection required: '+staging,{cause:error});
  if(fs.existsSync(staging))fs.rmSync(staging,{recursive:true,force:true});throw error;
 }
}
function allJson(root){const files=[];const walk=dir=>{for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),st=fs.lstatSync(file);if(st.isDirectory())walk(file);else if(st.isFile()&&name.endsWith('.json'))files.push(file);}};walk(root);return files;}
// [AI-added] 2026-09-24 11:10: Exclude copied source trees even when a source JSON file
// happens to contain a service path or is not parseable as service metadata.
function metadataJson(root){
 const files=[];
 const walk=(dir,parts=[])=>{for(const name of fs.readdirSync(dir)){
  const file=path.join(dir,name),st=fs.lstatSync(file),next=[...parts,name];
  if(st.isDirectory()){
   if(name==='tree'&&['artifacts','reviews','validations'].includes(parts[0]))continue;
   walk(file,next);
  }else if(st.isFile()&&name.endsWith('.json'))files.push(file);
 }};
 walk(root);return files;
}
async function main(){const input=args(process.argv.slice(2));if(!input.from)throw Error('Usage: node runtime/migrate-data.cjs --from "OLD_DATA" [--apply] [--workspace "PROJECT"]');console.log(JSON.stringify(input.apply?apply(input):preview(input),null,2));}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={preview,apply,replacePaths,digest};
