/* Runs as the accessing administrator. OWNER_EMAIL only gates optional legacy-data migration. No credentials in source. */
const OWNER_EMAIL='owner@example.com';
const SUBJECT_TAG='[서류체크 실험]';
const API_ORIGIN='https://api.upstage.ai/v2';
const WORKFLOW_ID='agt_H2fTK8CzwMhCsHeaNh9ZQy';
const WORKFLOW_CONFIG_VERSION='14';
function props_(){return PropertiesService.getUserProperties();}
function migrateOwnerData_(){
  const current=props_();if(current.getProperty('MIGRATED_V2'))return;
  if(Session.getEffectiveUser().getEmail().toLowerCase()===OWNER_EMAIL){
    const legacy=PropertiesService.getScriptProperties().getProperties();
    for(const [key,value] of Object.entries(legacy))if((key==='CONFIG'||key==='UPSTAGE_API_KEY'||key==='LAST_SCAN'||key.startsWith('MESSAGE_'))&&!current.getProperty(key))current.setProperty(key,value);
  }
  current.setProperty('MIGRATED_V2','true');
}
function authorize_(){
  const actual=Session.getEffectiveUser().getEmail().toLowerCase();
  const active=Session.getActiveUser().getEmail().toLowerCase();
  if(!emailAddress_(actual)||(active&&active!==actual))throw new Error('관리자 본인 계정으로 로그인해 주세요. 접속 사용자 권한으로 실행하는 배포가 필요합니다.');
  migrateOwnerData_();
  const saved=JSON.parse(props_().getProperty('CONFIG')||'{}');
  if(saved.managerEmail&&saved.managerEmail.toLowerCase()!==actual)throw new Error('등록한 관리자 이메일 계정으로 로그인해 주세요.');
  return actual;
}
function authorizeUi_(){const actual=authorize_();if(Session.getActiveUser().getEmail().toLowerCase()!==actual)throw new Error('관리자 계정 로그인이 필요합니다.');return actual;}
function doGet(){authorizeUi_();return HtmlService.createHtmlOutput(EMAIL_SERVICE_HTML_).setTitle('UpCheck · 접수 관리');}
function config_(){return {...JSON.parse(props_().getProperty('CONFIG')||'{}'),configId:WORKFLOW_CONFIG_VERSION};}
function saveConfiguration(input){
  const managerEmail=authorizeUi_();
  if(!input||emailAddress_(input.managerEmail)!==managerEmail)throw new Error('관리자 이메일은 현재 로그인한 Google 계정과 같아야 합니다. 다른 받은편지함을 연결하려면 해당 계정으로 웹앱에 접속해 주세요.');
  if(input.privacyConfirmed!==true)throw new Error('개인정보 처리 안내와 원문 AI 전송 범위를 확인해 주세요.');
  if(typeof input.notice!=='string'||input.notice.trim().length<50||input.notice.length>25000)throw new Error('안내문 원문을 50~25,000자 범위로 입력해 주세요.');

  const lock=LockService.getUserLock();
  if(!lock.tryLock(5000))throw new Error('메일 점검이 진행 중입니다. 잠시 후 설정을 다시 저장해 주세요.');
  try{
  const existing=config_();
  const storedKey=props_().getProperty('UPSTAGE_API_KEY')||'';
  const key=String(input.apiKey||storedKey).trim();
  if(!key)throw new Error('Upstage API 키를 보안 입력란에 등록해 주세요.');
  if(!/^up_[A-Za-z0-9_-]{20,200}$/.test(key))throw new Error('키 형식을 확인해 주세요. 소유자가 본인인 행의 복사 버튼을 누르세요. 별표로 가려진 문자열이나 코드는 키가 아닙니다.');
  const noticeText=input.notice.replace(/\r\n/g,'\n').trim();
  const connectionChanged=!existing.noticeFileId||noticeText!==String(existing.notice||'').replace(/\r\n/g,'\n').trim()||key!==storedKey;
  if(existing.enabled&&connectionChanged)throw new Error('안내문이나 API 키를 바꾸려면 먼저 자동 점검을 중지해 주세요.');
  let fileId=existing.noticeFileId;
  if(connectionChanged){
    const notice=Utilities.newBlob('<!doctype html><meta charset="utf-8"><h1>담당자가 등록한 제출 안내문</h1><pre>'+htmlEscape_(noticeText)+'</pre>','text/html','담당자_제출안내문.html');
    fileId=upload_(notice,key);
  }
  props_().setProperty('UPSTAGE_API_KEY',key);
  props_().setProperty('CONFIG',JSON.stringify({...existing,managerEmail,privacyConfirmed:true,notice:noticeText,noticeFileId:fileId,configId:WORKFLOW_CONFIG_VERSION,enabled:existing.enabled===true,autoSend:input.autoSend===true,startAfter:existing.startAfter||new Date().toISOString()}));
  return getDashboard();
  }finally{lock.releaseLock();}
}
function htmlEscape_(s){return s.replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));}
function getDashboard(){
  const managerEmail=authorizeUi_();const c=config_();
  const records=Object.entries(props_().getProperties()).filter(([k])=>k.startsWith('MESSAGE_')).map(([,v])=>JSON.parse(v)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100);
  const key=props_().getProperty('UPSTAGE_API_KEY')||'';
  return {currentUser:managerEmail,serviceVersion:'2026-11-10 자동 복구·개인정보·관리자 분리',config:{...c,noticeFileId:undefined},keyConfigured:!!key,keySuffix:key.slice(-4),records,subjectTag:SUBJECT_TAG,lastScan:props_().getProperty('LAST_SCAN')||null};
}
function setRunning(enabled){
  authorizeUi_();const c=config_();if(!c.noticeFileId||!props_().getProperty('UPSTAGE_API_KEY'))throw new Error('먼저 안내문과 연결 설정을 저장해 주세요.');
  c.enabled=enabled===true;
  const current=ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='scanMailbox');
  if(c.enabled&&!current.length)ScriptApp.newTrigger('scanMailbox').timeBased().everyMinutes(5).create();
  if(!c.enabled)current.forEach(t=>ScriptApp.deleteTrigger(t));
  props_().setProperty('CONFIG',JSON.stringify(c));return getDashboard();
}
function runNow(){authorizeUi_();if(!config_().enabled)throw new Error('자동 점검을 시작한 후 실행해 주세요.');scanMailbox();return getDashboard();}
function retryReview(messageId){
  authorizeUi_();const lock=LockService.getUserLock();
  if(!lock.tryLock(5000))throw new Error('점검 중입니다. 잠시 후 다시 시도해 주세요.');
  try{
    const c=config_();if(!c.enabled)throw new Error('자동 점검을 시작한 후 다시 점검해 주세요.');
    const r=JSON.parse(props_().getProperty('MESSAGE_'+String(messageId))||'null');
    if(!r||r.status!=='REVIEW'||r.sentAt||r.sendingStartedAt)throw new Error('자동 재점검할 수 있는 미발송 보류 건이 아닙니다. 발송 여부가 불명확한 메일은 다시 보내지 않습니다.');
    if(newerSubmissionExists_(r))throw new Error('보완 메일이 있어 최신 접수부터 확인해 주세요.');
    r.manualRechecks=(r.manualRechecks||0)+1;r.retryCount=0;r.runAttempts=0;r.nextRetryAt=null;r.retryStage='run';
    delete r.result;r.replyPreview='';r.status='UPLOADING';saveRecord_(r);
    const key=props_().getProperty('UPSTAGE_API_KEY');
    try{if(r.inputFileIds?.length)startRecordedJob_(r,c,key);else uploadAndStart_(r,c,key);}catch(e){recordFailure_(r,e,e.retryStage||'upload');}
    return getDashboard();
  }finally{lock.releaseLock();}
}
function api_(path,options,key){
  const r=UrlFetchApp.fetch(API_ORIGIN+path,{...options,headers:{Authorization:'Bearer '+key,...(options.headers||{})},muteHttpExceptions:true});
  if(r.getResponseCode()<200||r.getResponseCode()>=300){
    let detail='';try{const body=JSON.parse(r.getContentText());detail=String(body.error?.message||body.message||body.detail||body.error||'');}catch(e){detail=String(r.getContentText()).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');}
    detail=detail.split(key).join('[KEY]').replace(/up_[A-Za-z0-9*_-]+/g,'[KEY]').slice(0,300);
    throw new Error('Upstage 연결 오류 ('+r.getResponseCode()+', '+(path==='/files'?'파일 업로드':path==='/responses'?'워크플로우 실행':'결과 조회')+'): '+detail);
  }
  return JSON.parse(r.getContentText());
}
function upload_(blob,key){const f=api_('/files',{method:'post',payload:{file:blob,purpose:'user_data'}},key);if(!f.id&&!f.file_id)throw new Error('업로드 파일 ID 누락');return f.id||f.file_id;}
function saveRecord_(r){const text=JSON.stringify(r);if(Utilities.newBlob(text).getBytes().length>8500)throw new Error('점검 기록 크기 초과');props_().setProperty('MESSAGE_'+r.messageId,text);}

const MAX_AUTO_RETRIES=3;
const RETRY_DELAYS_MS=[60000,300000,900000];
function transientError_(e){
  return e.retryable===true||/\b(429|50[0-9]|51[0-9])\b|timed?\s*out|timeout|network|temporar|try again|service unavailable|시간\s*초과|네트워크/i.test(String(e.message||e));
}
function recordFailure_(r,e,stage){
  const detail=String(e.message||e).replace(/up_[A-Za-z0-9*_-]+/g,'[KEY]').slice(0,500);
  r.lastError=detail;
  if(r.status==='SENDING'||r.status==='SENT'||r.sendingStartedAt){
    r.status='SENDING';
    r.error='발송 응답을 확인하지 못했습니다. 다음 자동 점검에서 발송 기록을 확인하며 같은 안내를 다시 보내지 않습니다.';
    saveRecord_(r);return;
  }
  if(transientError_(e)&&(r.retryCount||0)<MAX_AUTO_RETRIES){
    r.retryCount=(r.retryCount||0)+1;
    r.retryStage=e.retryStage||stage;
    r.nextRetryAt=new Date(Date.now()+RETRY_DELAYS_MS[r.retryCount-1]).toISOString();
    r.status='RETRY_WAIT';
    r.error='일시적 오류로 자동 재시도 '+r.retryCount+'/'+MAX_AUTO_RETRIES+' 대기 중입니다. 다음 자동 점검에서 이어서 처리합니다.';
  }else{
    r.status='REVIEW';r.error=transientError_(e)?'자동 재시도 3회 후에도 완료되지 않아 담당자 확인이 필요합니다.':detail;
  }
  saveRecord_(r);
}
function startRecordedJob_(r,c,key){
  if(r.noticeFileId&&r.noticeFileId!==c.noticeFileId)throw new Error('등록 안내문이 바뀌어 담당자 재확인이 필요합니다.');
  if((r.runAttempts||0)>=MAX_AUTO_RETRIES+1)throw new Error('실행 접수 시도 한도에 도달했습니다. 담당자가 실행 기록을 확인해 주세요.');
  r.runAttempts=(r.runAttempts||0)+1;
  r.status='UPLOADING';r.attemptStartedAt=new Date().toISOString();saveRecord_(r);
  try{
    const job=api_('/responses',{method:'post',contentType:'application/json',payload:JSON.stringify({model:WORKFLOW_ID,config_id:WORKFLOW_CONFIG_VERSION,include:['last'],input:[{role:'user',content:r.inputFileIds.map(id=>({type:'input_file',file_id:id}))}]})},key);
    r.jobId=job.id||job.job_id;if(!r.jobId){const e=new Error('점검 실행 접수가 일시적으로 확인되지 않았습니다.');e.retryable=true;throw e;}
    r.status='PROCESSING';r.error='';r.jobStartedAt=new Date().toISOString();saveRecord_(r);
  }catch(e){e.retryStage='run';throw e;}
}
function uploadAndStart_(r,c,key){
  if(newerSubmissionExists_(r)){r.status='SUPERSEDED';r.error='최신 보완 메일이 있어 이전 접수의 재시도를 생략했습니다.';saveRecord_(r);return;}
  const message=GmailApp.getMessageById(r.messageId),managerEmail=authorize_();
  const sender=emailAddress_(message.getFrom()),subject=message.getSubject();
  if(sender!==r.sender||!subject.replace(/^(?:Re:\s*)+/i,'').startsWith(SUBJECT_TAG)||!message.getTo().toLowerCase().includes(managerEmail))throw new Error('점검 대상 메일과 관리자 정보를 다시 확인해 주세요.');
  if(emailAddress_(message.getReplyTo()||sender)!==sender)throw new Error('발신자와 회신 주소가 달라 담당자 확인이 필요합니다.');
  if(/auto-replied|auto-generated/i.test(message.getHeader('Auto-Submitted')||''))throw new Error('자동 생성 메일은 자동 회신하지 않습니다.');
  const byName=new Map();const history=message.getThread().getMessages().sort((a,b)=>a.getDate()-b.getDate());
  for(const old of history){
    if(old.getDate()>message.getDate()||emailAddress_(old.getFrom())!==sender||old.getSubject().replace(/^(?:Re:\s*)+/i,'')!==subject.replace(/^(?:Re:\s*)+/i,''))continue;
    const group=new Map();
    for(const file of old.getAttachments({includeInlineImages:false,includeAttachments:true})){
      const name=file.getName().normalize('NFC');if(!group.has(name))group.set(name,[]);group.get(name).push(file);
    }
    for(const [name,files]of group)byName.set(name,files);
  }
  const files=[...byName.values()].flat(),pdfs=files.filter(f=>/\.pdf$/i.test(f.getName()));
  r.files=files.map(f=>f.getName()).slice(0,20);r.originalAttached=files.some(f=>/\.hwpx?$/i.test(f.getName()));
  if(!pdfs.length)throw new Error('점검할 PDF 첨부파일이 없습니다.');
  if(pdfs.length>12||pdfs.reduce((n,f)=>n+f.getBytes().length,0)>20*1024*1024)throw new Error('실험 범위는 PDF 12개, 합계 20MB 이하입니다.');
  if(r.noticeFileId&&r.noticeFileId!==c.noticeFileId)throw new Error('등록 안내문이 바뀌어 담당자 재확인이 필요합니다.');
  r.status='UPLOADING';r.noticeFileId=c.noticeFileId;r.uploadedFileIds=r.uploadedFileIds||[];saveRecord_(r);
  for(let i=0;i<pdfs.length;i++)if(!r.uploadedFileIds[i]){r.uploadedFileIds[i]=upload_(pdfs[i],key);saveRecord_(r);}
  r.inputFileIds=[c.noticeFileId,...r.uploadedFileIds];saveRecord_(r);startRecordedJob_(r,c,key);
}
function resumeRecord_(r,c,key){
  if(newerSubmissionExists_(r)){r.status='SUPERSEDED';r.error='최신 보완 메일이 있어 이전 접수의 재시도를 생략했습니다.';saveRecord_(r);return;}
  if(r.retryStage==='poll'&&r.jobId){r.status='PROCESSING';saveRecord_(r);finishJob_(r,c,key);}
  else if(r.inputFileIds?.length)startRecordedJob_(r,c,key);
  else uploadAndStart_(r,c,key);
}
function reconcileSending_(r){
  // A send with an uncertain outcome is never automatically repeated.
  const marker='서류체크 안내번호 '+r.messageId;
  const since=r.sendingStartedAt?new Date(r.sendingStartedAt).getTime()-60000:0;
  const manager=authorize_();
  const thread=GmailApp.getMessageById(r.messageId).getThread();
  const sent=thread.getMessages().find(m=>emailAddress_(m.getFrom())===manager&&m.getDate().getTime()>=since&&typeof m.getPlainBody==='function'&&m.getPlainBody().includes(marker));
  if(sent){r.status='SENT';r.sentAt=sent.getDate().toISOString();r.error='';saveRecord_(r);return;}
  if(newerSubmissionExists_(r)){r.status='SUPERSEDED';r.error='최신 보완 메일이 있어 이전 안내를 다시 보내지 않습니다.';saveRecord_(r);return;}
  r.sendChecks=(r.sendChecks||0)+1;
  r.status=r.sendChecks>=3?'REVIEW':'SENDING';
  r.error=r.sendChecks>=3?'발송 여부를 확정하지 못했습니다. 중복 발송 방지를 위해 담당자가 확인해 주세요.':'발송 여부를 자동 확인 중입니다. 같은 안내를 다시 보내지 않습니다.';saveRecord_(r);
}
function scanMailbox(){
  const managerEmail=authorize_(),lock=LockService.getUserLock();if(!lock.tryLock(5000))return;
  try{
    const c=config_();if(!c.enabled)return;const key=props_().getProperty('UPSTAGE_API_KEY');
    props_().setProperty('LAST_SCAN',new Date().toISOString());const all=props_().getProperties();let work=0;
    const pending=Object.entries(all).filter(([name])=>name.startsWith('MESSAGE_')).map(([,value])=>JSON.parse(value)).sort((a,b)=>new Date(a.lastCheckedAt||a.createdAt).getTime()-new Date(b.lastCheckedAt||b.createdAt).getTime());
    for(const r of pending){
      if(work>=3)break;
      if(!['PROCESSING','RETRY_WAIT','UPLOADING','SENDING'].includes(r.status)||(r.status==='RETRY_WAIT'&&Date.now()<new Date(r.nextRetryAt||0).getTime()))continue;
      r.lastCheckedAt=new Date().toISOString();saveRecord_(r);
      if(r.status==='PROCESSING'){work++;try{finishJob_(r,c,key);}catch(e){recordFailure_(r,e,e.retryStage||'poll');}}
      else if(r.status==='RETRY_WAIT'&&Date.now()>=new Date(r.nextRetryAt||0).getTime()){work++;try{resumeRecord_(r,c,key);}catch(e){recordFailure_(r,e,e.retryStage||r.retryStage||'upload');}}
      else if(r.status==='UPLOADING'){work++;try{resumeRecord_(r,c,key);}catch(e){recordFailure_(r,e,e.retryStage||'upload');}}
      else if(r.status==='SENDING'){work++;try{reconcileSending_(r);}catch(e){r.error='발송 기록 확인을 다음 자동 점검에서 다시 시도합니다.';saveRecord_(r);}}
    }
    if(Object.keys(all).filter(k=>k.startsWith('MESSAGE_')).length>=120)return;
    const after=Math.floor(new Date(c.startAfter).getTime()/1000);
    const threads=GmailApp.search('to:'+managerEmail+' subject:"서류체크 실험" after:'+after+' -in:spam -in:trash',0,30);
    for(const thread of threads)for(const message of thread.getMessages()){
      if(work>=6)return;
      const sender=emailAddress_(message.getFrom()),subject=message.getSubject();
      if(!subject.replace(/^(?:Re:\s*)+/i,'').startsWith(SUBJECT_TAG)||!sender||sender===managerEmail||message.getDate().getTime()<new Date(c.startAfter).getTime()||message.isDraft()||message.isInTrash()||!message.getTo().toLowerCase().includes(managerEmail))continue;
      const id=message.getId(),previous=JSON.parse(props_().getProperty('MESSAGE_'+id)||'null');if(previous&&previous.status!=='RETRY')continue;
      const r=previous||{messageId:id,threadId:thread.getId(),sender,subject:subject.slice(0,160),createdAt:message.getDate().toISOString(),retryCount:0};r.status='UPLOADING';saveRecord_(r);work++;
      try{uploadAndStart_(r,c,key);}catch(e){recordFailure_(r,e,e.retryStage||'upload');}
    }
  }finally{lock.releaseLock();}
}
// Explicit retry only for a rejected connection with no accepted job or sent email.
function retryLatestConnectionFailure(){
  authorizeUi_();
  if(!config_().enabled)throw new Error('자동 점검을 시작한 후 재시도해 주세요.');
  const records=getDashboard().records;
  const r=records.find(x=>x.status==='REVIEW'&&!x.jobId&&!x.sentAt&&/^Upstage 연결 오류 \((401|403),?/.test(x.error||''));
  if(!r)throw new Error('재시도할 연결 오류가 없습니다.');
  if(newerSubmissionExists_(r))throw new Error('같은 대화의 최신 제출 메일을 먼저 처리해 주세요.');
  r.status='RETRY';r.retryCount=0;r.nextRetryAt=null;r.retryStage=null;saveRecord_(r);scanMailbox();
  const updated=JSON.parse(props_().getProperty('MESSAGE_'+r.messageId));
  console.log(JSON.stringify({status:updated.status,error:updated.error||null,jobCreated:!!updated.jobId}));
  return getDashboard();
}
function newerSubmissionExists_(r){
  const message=GmailApp.getMessageById(r.messageId);
  const subject=r.subject.replace(/^(?:Re:\s*)+/i,'');
  return message.getThread().getMessages().some(m=>
    m.getId()!==r.messageId && m.getDate().getTime()>new Date(r.createdAt).getTime() &&
    emailAddress_(m.getFrom())===r.sender &&
    m.getSubject().replace(/^(?:Re:\s*)+/i,'').slice(0,160)===subject &&
    !m.isDraft() && !m.isInTrash());
}
function finishJob_(r,c,key){
  const newer=newerSubmissionExists_(r);
  if(newer){r.status='SUPERSEDED';r.error='같은 접수의 보완 메일이 있어 이전 결과 안내를 생략했습니다.';saveRecord_(r);return;}
  const job=api_('/responses/'+encodeURIComponent(r.jobId)+'?include=last',{method:'get'},key);
  if(['queued','in_progress'].includes(job.status))return;
  if(job.status==='failed'||job.status==='expired'){const e=new Error('AI 실행이 일시적으로 실패했습니다.');e.retryable=true;e.retryStage='run';throw e;}
  if(job.status!=='completed')throw new Error('AI 점검이 완료되지 않았습니다: '+job.status);
  let result;try{result=readResult_(job);}catch(e){e.retryable=true;e.retryStage='run';throw e;}
  const plan=safeReplyPlan_(result);r.result=result;r.replyPreview=plan.body||'';r.error='';
  if(plan.kind==='review'){r.status='REVIEW';r.error=plan.reason;saveRecord_(r);return;}
  if(plan.kind==='complete'){r.status='COMPLETE';saveRecord_(r);return;}
  if(!c.autoSend){r.status='READY';saveRecord_(r);return;}
  // Persist BEFORE sending: uncertain network outcomes are never blindly retried.
  r.status='SENDING';r.sendingStartedAt=new Date().toISOString();saveRecord_(r);
  const marker='서류체크 안내번호 '+r.messageId;
  GmailApp.getMessageById(r.messageId).reply(plan.body+'\n\n'+marker,{name:'UpCheck · 제출서류 점검',htmlBody:plan.htmlBody+'<p style="font:11px Arial;color:#857b91">'+escapeHtml_(marker)+'</p>'});
  r.status='SENT';r.sentAt=new Date().toISOString();saveRecord_(r);
}
