const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../build/Deploy.gs'),'utf8');
const truth=JSON.parse(fs.readFileSync(path.join(__dirname,'../evaluation/answer.json'),'utf8')).cases[1].answer;
function setup(){
 let now=Date.parse('2026-11-10T01:00:00Z'),uploads=[],creates=0,polls=0,replies=0,failUpload=false,failPoll=false,failCreate403=false,terminalFailed=false,malformed=false,replyThrows=false,failSentSave=false;
 const data={CONFIG:JSON.stringify({enabled:true,autoSend:false,managerEmail:'owner@example.com',noticeFileId:'notice',startAfter:'2026-11-09T00:00:00Z'}),UPSTAGE_API_KEY:'test-only'};
 const file=name=>({getName:()=>name,getBytes:()=>[37,80,68,70]});
 const files=[file('신청.pdf'),file('동의.pdf')];let messages=[];
 const thread={getId:()=> 'thread',getMessages:()=>messages};
 function message(id='m1',sender='student@example.com',body='',date='2026-11-10T00:00:00Z'){
  return {getThread:()=>thread,getId:()=>id,getFrom:()=>sender,getReplyTo:()=>sender,getTo:()=> 'owner@example.com',getSubject:()=> '[서류체크 실험] 복구검증',getDate:()=>new Date(date),isDraft:()=>false,isInTrash:()=>false,getHeader:()=>'',getAttachments:()=>files,getPlainBody:()=>body,reply:body=>{replies++;messages.push(message('sent1','owner@example.com',body,new Date(now).toISOString()));if(replyThrows)throw new Error('Network timeout after send');}};
 }
 messages.push(message());
 class ClockDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const ctx={console,Date:ClockDate,PropertiesService:{getScriptProperties:()=>({getProperties:()=>({})}),getUserProperties:()=>({getProperty:k=>data[k]??null,setProperty:(k,v)=>{if(failSentSave&&k.startsWith('MESSAGE_')&&JSON.parse(v).status==='SENT'){failSentSave=false;throw new Error('Temporary storage unavailable');}data[k]=v;},getProperties:()=>({...data})})},Session:{getEffectiveUser:()=>({getEmail:()=> 'owner@example.com'}),getActiveUser:()=>({getEmail:()=> 'owner@example.com'})},LockService:{getUserLock:()=>({tryLock:()=>true,releaseLock(){}})},Utilities:{newBlob:v=>({getBytes:()=>Buffer.from(String(v))})},GmailApp:{search:()=>[thread],getMessageById:id=>messages.find(m=>m.getId()===id)},ScriptApp:{getProjectTriggers:()=>[]},UrlFetchApp:{fetch:(url,opt)=>{
  const ok=v=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(v)}),error=code=>({getResponseCode:()=>code,getContentText:()=>JSON.stringify({error:{message:'test failure'}})});
  if(url.endsWith('/files')){uploads.push(opt.payload.file.getName());if(failUpload&&uploads.length===2)throw new Error('Network timeout');return ok({id:'file_'+uploads.length});}
  if(url.endsWith('/responses')){creates++;if(failCreate403)return error(403);return ok({id:'job_'+creates,status:'queued'});}
  polls++;if(failPoll&&polls===1)return error(503);if(terminalFailed&&polls===1)return ok({status:'failed'});return ok({status:'completed',output_text:malformed?'not a JSON result':JSON.stringify(truth)});
 }}};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 const get=()=>JSON.parse(data.MESSAGE_m1),put=r=>data.MESSAGE_m1=JSON.stringify(r);
 return {ctx,data,get,put,message,messages,uploads,stats:()=>({creates,polls,replies}),advance:()=>{now+=20*60000;},failUpload:()=>failUpload=true,failPoll:()=>failPoll=true,failCreate403:()=>failCreate403=true,terminalFailed:()=>terminalFailed=true,malformed:()=>malformed=true,replyThrows:()=>replyThrows=true,failSentSave:()=>failSentSave=true};
}
// Partial upload -> retry only the unfinished attachment -> known-job poll retry.
{
 const t=setup();t.failUpload();t.ctx.scanMailbox();assert.equal(t.get().status,'RETRY_WAIT');assert.equal(t.get().retryStage,'upload');assert.equal(t.get().uploadedFileIds.length,1);
 t.advance();t.ctx.scanMailbox();assert.equal(t.get().status,'PROCESSING');assert.deepEqual(t.uploads,['신청.pdf','동의.pdf','동의.pdf']);assert.equal(t.stats().creates,1);
 t.failPoll();t.ctx.scanMailbox();assert.equal(t.get().retryStage,'poll');const id=t.get().jobId;
 t.advance();t.ctx.scanMailbox();assert.equal(t.get().status,'READY');assert.equal(t.get().jobId,id);assert.equal(t.stats().creates,1);assert.equal(t.stats().replies,0);
}
// A terminal AI failure resumes from existing input IDs, without re-uploading.
{
 const t=setup();t.ctx.scanMailbox();t.terminalFailed();t.ctx.scanMailbox();assert.equal(t.get().status,'RETRY_WAIT');assert.equal(t.get().retryStage,'run');
 const uploadCount=t.uploads.length;t.advance();t.ctx.scanMailbox();assert.equal(t.stats().creates,2);assert.equal(t.uploads.length,uploadCount);t.ctx.scanMailbox();assert.equal(t.get().status,'READY');
}
// Invalid result JSON is retried at most three times, then escalated without mail.
{
 const t=setup();t.malformed();t.ctx.scanMailbox();
 for(let i=0;i<4;i++){t.ctx.scanMailbox();if(i<3){assert.equal(t.get().status,'RETRY_WAIT');assert.equal(t.get().retryCount,i+1);t.advance();t.ctx.scanMailbox();}}
 assert.equal(t.get().status,'REVIEW');assert.equal(t.stats().creates,4);assert.equal(t.stats().replies,0);
}
// Permission errors are permanent until the manager fixes the connection.
{
 const t=setup();t.failCreate403();t.ctx.scanMailbox();assert.equal(t.get().status,'REVIEW');assert.equal(t.get().retryCount,0);t.advance();t.ctx.scanMailbox();assert.equal(t.stats().creates,1);
}
// A worker interrupted after a partial upload resumes from the persisted IDs.
{
 const t=setup();t.put({messageId:'m1',threadId:'thread',sender:'student@example.com',subject:'[서류체크 실험] 복구검증',createdAt:'2026-11-10T00:00:00Z',status:'UPLOADING',noticeFileId:'notice',uploadedFileIds:['already-uploaded']});
 t.ctx.scanMailbox();assert.equal(t.get().status,'PROCESSING');assert.deepEqual(t.uploads,['동의.pdf']);
}
// A sent mail whose final save was lost is reconciled, not sent again.
{
 const t=setup();t.put({messageId:'m1',sender:'student@example.com',subject:'[서류체크 실험] 복구검증',createdAt:'2026-11-10T00:00:00Z',status:'SENDING',sendingStartedAt:'2026-11-10T00:59:00Z'});
 t.messages.push(t.message('sent1','owner@example.com','서류체크 안내번호 m1','2026-11-10T01:00:00Z'));t.ctx.scanMailbox();assert.equal(t.get().status,'SENT');assert.equal(t.stats().replies,0);
}
// An uncertain mail is inspected three times and held for review, never resent.
{
 const t=setup();t.put({messageId:'m1',sender:'student@example.com',subject:'[서류체크 실험] 복구검증',createdAt:'2026-11-10T00:00:00Z',status:'SENDING',sendingStartedAt:'2026-11-10T00:59:00Z'});
 for(let i=0;i<3;i++){t.ctx.scanMailbox();t.advance();}assert.equal(t.get().status,'REVIEW');assert.equal(t.stats().replies,0);
}
// A transport failure AFTER sending must never enter the workflow retry path.
{
 const t=setup();const config=JSON.parse(t.data.CONFIG);config.autoSend=true;t.data.CONFIG=JSON.stringify(config);t.replyThrows();
 t.ctx.scanMailbox();t.ctx.scanMailbox();assert.equal(t.get().status,'SENDING');assert.equal(t.stats().replies,1);
 t.advance();t.ctx.scanMailbox();assert.equal(t.get().status,'SENT');assert.equal(t.stats().replies,1);
}
// A failed final save after Gmail accepted the reply is also reconciled once.
{
 const t=setup();const config=JSON.parse(t.data.CONFIG);config.autoSend=true;t.data.CONFIG=JSON.stringify(config);t.failSentSave();
 t.ctx.scanMailbox();t.ctx.scanMailbox();assert.equal(t.get().status,'SENDING');assert.equal(t.stats().replies,1);
 t.advance();t.ctx.scanMailbox();assert.equal(t.get().status,'SENT');assert.equal(t.stats().replies,1);
}
// Interrupted execution creation is bounded even when the worker was killed.
{
 const t=setup();t.put({messageId:'m1',sender:'student@example.com',subject:'[서류체크 실험] 복구검증',createdAt:'2026-11-10T00:00:00Z',status:'UPLOADING',noticeFileId:'notice',inputFileIds:['notice','pdf'],runAttempts:4});
 t.ctx.scanMailbox();assert.equal(t.get().status,'REVIEW');assert.equal(t.stats().creates,0);
}
// A manager can re-run a reviewed, never-sent record with the current workflow.
{
 const t=setup();t.ctx.scanMailbox();const r=t.get();r.status='REVIEW';r.result={...truth,signature_status:'누락'};t.put(r);const uploads=t.uploads.length;
 t.ctx.retryReview('m1');assert.equal(t.get().status,'PROCESSING');assert.equal(t.get().manualRechecks,1);assert.equal(t.stats().creates,2);assert.equal(t.uploads.length,uploads);
 const uncertain=t.get();uncertain.status='REVIEW';uncertain.sendingStartedAt='2026-11-10T00:59:00Z';t.put(uncertain);assert.throws(()=>t.ctx.retryReview('m1'),/미발송 보류/);assert.equal(t.stats().creates,2);
}
console.log('PASS: upload continuation, same-job poll recovery, bounded workflow retries, manager recheck of unsent reviews, and no resend after uncertain delivery.');
