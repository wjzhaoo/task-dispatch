// [AI-added] 2026-09-22 09:20: Offline example; the ledger and raw runs are authoritative.
'use strict';
const fs=require('node:fs'),path=require('node:path');
function generate(data){
 return {totalCalls:data.ledger.length,scenarios:data.raw.map(r=>({id:r.id,status:r.status,shots:r.shots.length,calls:data.ledger.filter(c=>c.scenario===r.id).map(c=>c.index)}))};
}
function validate(data){
 const checks=[];
 const check=(id,errors)=>checks.push({id,passed:errors.length===0,errors});
 const error=(path,message)=>({path,message});
 const ids=data.raw.map(r=>r.id),indexes=data.ledger.map(c=>c.index);
 check('ledger-partition',[
  ...(new Set(ids).size!==ids.length?[error('raw','Duplicate scenario ID')]:[]),
  ...(new Set(indexes).size!==indexes.length?[error('ledger','Duplicate call index')]:[]),
  ...(indexes.some(x=>!Number.isSafeInteger(x)||x<data.firstCall||x>data.lastCall)||indexes.length!==data.lastCall-data.firstCall+1?[error('ledger','Call range is incomplete or invalid')]:[]),
  ...data.ledger.filter(c=>!ids.includes(c.scenario)).map(c=>error('ledger/'+c.index,'Unknown scenario'))
 ]);
 const expected=generate(data),actual=data.report;
 check('report-total',actual.totalCalls===expected.totalCalls?[]:[error('report/totalCalls','Count differs from global ledger')]);
 check('report-runs',JSON.stringify(actual.scenarios)===JSON.stringify(expected.scenarios)?[]:[error('report/scenarios','Status, shot count or call indexes differ from raw/ledger')]);
 check('anonymous-material',[
  ...(data.anonymous.length!==data.raw.length?[error('anonymous','Expected one material entry per scenario')]:[]),
  ...data.raw.flatMap(r=>{
   const found=data.anonymous.filter(a=>a.scenario===r.id);
   return found.length===1&&JSON.stringify(found[0].shots)===JSON.stringify(r.shots)?[]:[error('anonymous/'+r.id,'Existing shots missing, duplicated or changed')];
  })
 ]);
 return {version:1,checks};
}
if(require.main===module){
 const input=process.argv[2]||path.join(__dirname,'fixture.json');
 const output=process.argv[3]||path.resolve('tmp/evidence-result.json');
 const result=validate(JSON.parse(fs.readFileSync(input,'utf8')));
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n','utf8');
 if(result.checks.some(c=>!c.passed))process.exitCode=1;
}
module.exports={generate,validate};
