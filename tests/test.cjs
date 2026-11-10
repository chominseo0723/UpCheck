const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');
const {readResult_,safeReplyPlan_,emailAddress_}=require('../src/Core.js');
const truth=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../evaluation/answer.json'),'utf8'));
const a=truth.cases[0].answer,b=truth.cases[1].answer,c=truth.cases[2].answer,h=truth.cases[7].answer;
assert.deepEqual(readResult_({output:[{content:[{text:'```json\n'+JSON.stringify(b)+'\n```\n근거 [1]'}]}]}),b);
assert.throws(()=>readResult_({output:[a,b]}),/하나로/);
assert.throws(()=>readResult_('형식 오류'),/확정/);
assert.equal(safeReplyPlan_(a).kind,'complete');
assert.equal(safeReplyPlan_(h).kind,'review');
assert.equal(safeReplyPlan_({...a,missing_documents:['활동서약서']}).kind,'review');
assert.equal(safeReplyPlan_({...a,decision:'보완 요청'}).kind,'review');
assert.equal(safeReplyPlan_({...a,signature_status:'누락'}).kind,'review');
assert.equal(safeReplyPlan_({...a,format_status:'담당자 확인'}).kind,'review');
assert.equal(safeReplyPlan_({...a,signature_status:'알 수 없는 상태'}).kind,'review');
assert.match(safeReplyPlan_(b).body,/개인정보 동의서:박\*민/);
assert.match(safeReplyPlan_(c).body,/중복 제출/);
assert.equal(emailAddress_('제출자 <student@example.com>'),'student@example.com');
assert.equal(emailAddress_('victim@example.com, attacker@example.com'),null);

// Execute the real mail adapter with isolated mocks: strict scope, cumulative attachments,
// source-derived recipient, no resend after uncertain send, and bounded scheduled processing.
const data={};let requests=[],sent=[],triggers=[];
function msg(id,from,subject,files,date='2026-11-09T04:00:00Z'){
 return {getThread:()=>({getMessages:()=>messages}),getId:()=>id,getFrom:()=>from,getReplyTo:()=>from,getTo:()=> 'owner@example.com',getSubject:()=>subject,getDate:()=>new Date(date),isDraft:()=>false,isInTrash:()=>false,getHeader:()=>'',getAttachments:()=>files,reply:body=>sent.push({id,body})};
}
function attachment(name){return {getName:()=>name,getBytes:()=>[37,80,68,70]};}
const first=msg('m1','student@example.com','[서류체크 실험] A',[attachment('신청.pdf')]);
const second=msg('m2','student@example.com','Re: [서류체크 실험] A',[attachment('동의.pdf')],'2026-11-09T05:00:00Z');
const ordinary=msg('m3','friend@example.com','일반 메일',[attachment('private.pdf')]);
const self=msg('m4','owner@example.com','[서류체크 실험] A',[attachment('self.pdf')]);
let messages=[first,second,ordinary,self];
const context={console,Map,Date,JSON,Object,Array,RegExp,String,Number,Boolean,encodeURIComponent,
 PropertiesService:{getScriptProperties:()=>({getProperties:()=>({})}),getUserProperties:()=>({getProperty:k=>data[k]||null,setProperty:(k,v)=>{data[k]=v;},getProperties:()=>({...data})})},
 Session:{getEffectiveUser:()=>({getEmail:()=> 'owner@example.com'}),getActiveUser:()=>({getEmail:()=> 'owner@example.com'})},
 LockService:{getUserLock:()=>({tryLock:()=>true,releaseLock(){}})},
 Utilities:{newBlob:v=>({getBytes:()=>Buffer.from(String(v))})},
 ScriptApp:{getProjectTriggers:()=>triggers},
 GmailApp:{search:()=>[{getMessages:()=>messages,getId:()=> 't1'}],getMessageById:id=>messages.find(m=>m.getId()===id)},
 UrlFetchApp:{fetch:(url,opt)=>{requests.push({url,opt});let payload=url.endsWith('/files')?{id:'file_'+requests.length}:url.includes('?include=last')?{status:'completed',output_text:JSON.stringify(b)}:{id:'job_'+requests.length,status:'queued'};return{getResponseCode:()=>200,getContentText:()=>JSON.stringify(payload)};}}
};
vm.createContext(context);vm.runInContext(fs.readFileSync(__dirname+'/../src/Core.js','utf8')+'\n'+fs.readFileSync(__dirname+'/../src/Code.gs','utf8'),context);
data.CONFIG=JSON.stringify({enabled:true,autoSend:true,startAfter:'2026-11-09T03:00:00Z',noticeFileId:'notice',configId:'4'});data.UPSTAGE_API_KEY='test-only';
context.scanMailbox();
assert.ok(data.MESSAGE_m1&&data.MESSAGE_m2);assert.equal(data.MESSAGE_m3,undefined);assert.equal(data.MESSAGE_m4,undefined);
const jobs=requests.filter(r=>r.url.endsWith('/responses')).map(r=>JSON.parse(r.opt.payload));
assert.ok(jobs.every(job=>job.config_id==='14'),'stored older versions must never change the execution version');
assert.equal(jobs.length,1,'a submission superseded before processing must not start a stale AI job');
assert.equal(jobs[0].input[0].content.length,3);
context.scanMailbox();assert.equal(sent.length,1);
assert.equal(JSON.parse(data.MESSAGE_m1).status,'SUPERSEDED','newer submission must prevent stale missing-document replies');
assert.equal(sent[0].id,'m2');
context.scanMailbox();assert.equal(sent.length,1,'same messages must not be replied to twice');
const r=JSON.parse(data.MESSAGE_m1);r.status='SENDING';data.MESSAGE_m1=JSON.stringify(r);context.scanMailbox();assert.equal(sent.length,1);assert.equal(JSON.parse(data.MESSAGE_m1).status,'SUPERSEDED');
const duplicates=msg('m5','student@example.com','[서류체크 실험] B',[attachment('동의.pdf'),attachment('동의.pdf')],'2026-11-09T06:00:00Z');
messages=[duplicates];context.scanMailbox();
const duplicateJob=JSON.parse(requests.filter(r=>r.url.endsWith('/responses')).at(-1).opt.payload);
assert.equal(duplicateJob.input[0].content.length,3,'same-name attachments within a message must both reach AI for duplicate detection');
messages.push(msg('m6','student@example.com','Re: [서류체크 실험] B',[attachment('동의.pdf')],'2026-11-09T07:00:00Z'));
context.scanMailbox();
assert.equal(JSON.parse(data.MESSAGE_m5).status,'SUPERSEDED','unqueued newer mail must suppress stale replies');
assert.equal(sent.length,1);
assert.equal(JSON.parse(requests.filter(r=>r.url.endsWith('/responses')).at(-1).opt.payload).input[0].content.length,2,'resubmission replaces the previous same-name group');
const fetchBefore=context.UrlFetchApp.fetch;
context.UrlFetchApp.fetch=()=>({getResponseCode:()=>403,getContentText:()=>JSON.stringify({error:{message:'No access; key test-only up_abcdefghijklmnop'}})});
assert.throws(()=>context.api_('/responses',{},'test-only'),e=>e.message.includes('워크플로우 실행')&&e.message.includes('No access')&&!e.message.includes('test-only')&&!e.message.includes('up_abcdefghijklmnop'));
context.UrlFetchApp.fetch=fetchBefore;
assert.equal(context.getDashboard().keySuffix,'only');
assert.ok(context.getDashboard().lastScan);
const previousConfig=data.CONFIG;data.CONFIG=JSON.stringify({...JSON.parse(previousConfig),enabled:false});
assert.throws(()=>context.retryLatestConnectionFailure(),/시작/);
data.CONFIG=previousConfig;
const input={managerEmail:'owner@example.com',privacyConfirmed:true,notice:'test notice '.repeat(8),configId:'5',apiKey:'up_********demo'};
data.CONFIG=JSON.stringify({enabled:false});assert.throws(()=>context.saveConfiguration(input),/키 형식/);data.CONFIG=previousConfig;
data.CONFIG=JSON.stringify({enabled:false,configId:'4'});
context.saveConfiguration({...input,configId:'999',apiKey:'up_'+('a'.repeat(24))});
assert.equal(JSON.parse(data.CONFIG).configId,'14','client version must be ignored');
assert.equal(context.getDashboard().config.configId,'14');
const html=fs.readFileSync(__dirname+'/../src/Index.html','utf8');
assert.ok(!html.includes('id="config"'));
assert.ok(!html.includes('href="#flow"'));
assert.ok(!html.includes('href="#settings"'));new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
context.Session.getActiveUser=()=>({getEmail:()=>''});assert.throws(()=>context.getDashboard(),/로그인/);
console.log('PASS: JSON parsing, conservative decisions, scoped selection, cumulative resubmission, same-name duplicate preservation, stale reply suppression, at-most-once replies. This local test does not exercise real Gmail/API integration.');
