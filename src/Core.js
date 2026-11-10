/* Pure domain rules shared by Apps Script and local verification. */
const RESULT_KEYS = ['packet_id','required_type_count','expected_count','received_count','missing_documents','duplicate_documents','uncertain_documents','format_status','signature_status','decision','reason','scope'];
function validResult_(r) {
  if(!r || typeof r!=='object' || !RESULT_KEYS.every(k=>Object.prototype.hasOwnProperty.call(r,k))) return false;
  if(!['required_type_count','expected_count','received_count'].every(k=>Number.isInteger(r[k])&&r[k]>=0))return false;
  if(!['missing_documents','duplicate_documents','uncertain_documents'].every(k=>Array.isArray(r[k])&&r[k].length<=100&&r[k].every(v=>typeof v==='string'&&v.length<=200)))return false;
  if(!['packet_id','format_status','signature_status','decision','reason','scope'].every(k=>typeof r[k]==='string'&&r[k].length<=2000))return false;
  if(!['원본 확인 필요','담당자 확인','PDF 확인'].includes(r.format_status))return false;
  if(!['표시 확인','누락','담당자 확인','별도 요건 없음'].includes(r.signature_status))return false;
  return ['내용 완비','보완 요청','담당자 확인'].includes(r.decision)&&r.scope==='PDF 내용 사전 점검';
}
function readResult_(raw) {
  const found=[];
  function visit(v,depth){
    if(depth>14||v==null)return;
    if(typeof v==='string'){
      try{visit(JSON.parse(v),depth+1);return;}catch(e){}
      const blocks=[...v.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
      for(const b of blocks){try{visit(JSON.parse(b[1]),depth+1);}catch(e){}}
    }else if(typeof v==='object'){
      if(validResult_(v)){found.push(Object.fromEntries(RESULT_KEYS.map(k=>[k,v[k]])));return;}
      for(const x of Object.values(v))visit(x,depth+1);
    }
  }
  visit(raw,0);
  const unique=[...new Map(found.map(x=>[JSON.stringify(x),x])).values()];
  if(unique.length!==1)throw new Error('결과 JSON을 하나로 확정할 수 없습니다. 담당자 확인이 필요합니다.');
  return unique[0];
}
function emailAddress_(header){
  const s=String(header||'').trim();
  const m=s.match(/<([^<>]+)>\s*$/);const a=(m?m[1]:s).toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(a)?a:null;
}
function safeReplyPlan_(r) {
  if(!validResult_(r))return {kind:'review',reason:'결과 형식 오류'};
  if(r.uncertain_documents.length)return{kind:'review',reason:'불명확한 서류가 있어 자동 안내를 보류했습니다.'};
  if(r.signature_status==='누락')return{kind:'review',reason:'필수 서명이 누락된 것으로 판정되어 자동 안내를 보류했습니다. 제출본의 서명 표시를 확인해 주세요.'};
  if(r.signature_status==='담당자 확인')return{kind:'review',reason:'서명 표시를 확정할 수 없어 자동 안내를 보류했습니다.'};
  if(r.decision==='담당자 확인'||r.format_status==='담당자 확인'||!r.expected_count||!r.required_type_count||r.required_type_count>r.expected_count)return{kind:'review',reason:'제출 기준이나 형식이 확정되지 않아 담당자 확인이 필요합니다.'};
  const issues=r.missing_documents.length+r.duplicate_documents.length;
  if(r.decision==='내용 완비')return{kind:issues?'review':'complete',reason:issues?'판정과 목록이 서로 다름':'PDF 내용 확인 완료'};
  if(r.decision!=='보완 요청'||!issues)return{kind:'review',reason:'자동 안내할 누락·중복 항목이 없음'};
  const parts=['안녕하세요. 제출하신 서류를 등록된 안내문과 대조한 사전 점검 결과입니다.'];
  if(r.missing_documents.length)parts.push('다음 서류가 누락되었습니다.\n'+r.missing_documents.map(x=>'• '+privateLabel_(x)).join('\n'));
  if(r.duplicate_documents.length)parts.push('다음 서류가 중복 제출되었습니다.\n'+r.duplicate_documents.map(x=>'• '+privateLabel_(x)).join('\n'));
  parts.push('빠진 서류 또는 수정한 서류를 이 메일에 답장으로 첨부해 주세요. 같은 이름의 파일을 다시 보내면 최신 파일로 점검합니다.');
  parts.push('이 알림은 PDF 내용 사전 점검 결과입니다. 한글 원본 제출, 서명 진위 및 최종 접수 여부는 담당자가 별도로 확인합니다.');
  parts.push('개인정보 안내: 제출 문서는 누락·중복 대조를 위해 Upstage AI로 전송됩니다. 안내 메일에는 작성자 이름을 일부 가려 표시하며 원문·연락처·서명 이미지를 첨부하지 않습니다. 처리·보관·삭제 문의는 이 메일의 수신 담당자에게 요청해 주세요.');
  return{kind:'notify',body:parts.join('\n\n'),htmlBody:replyHtml_(r)};
}
if(typeof module!=='undefined')module.exports={RESULT_KEYS,validResult_,readResult_,emailAddress_,safeReplyPlan_};


// Display-only privacy filters never alter the Studio result or grading JSON.
function escapeHtml_(v){return String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));}
function privateLabel_(value){
  const s=String(value||'');const at=s.indexOf(':');if(at<0)return s;
  const type=s.slice(0,at),name=s.slice(at+1).trim();
  if(!name||name==='작성자 불명')return type+':'+name;
  const chars=Array.from(name);const masked=chars.length<2?'*':chars.length===2?chars[0]+'*':chars[0]+'*'.repeat(Math.min(chars.length-2,6))+chars.at(-1);
  return type+':'+masked;
}
function replyHtml_(r){
  const section=(title,items)=>!items.length?'':'<h2 style="font-size:16px;margin:26px 0 10px;color:#332450">'+title+'</h2><ul style="padding-left:22px;margin:0;line-height:2">'+items.map(x=>'<li>'+escapeHtml_(privateLabel_(x))+'</li>').join('')+'</ul>';
  return '<!doctype html><html lang="ko"><body style="margin:0;background:#f5f3fa;font-family:Arial,Malgun Gothic,sans-serif;color:#24202e"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 12px"><table role="presentation" width="100%" style="max-width:600px;margin:auto;background:#fff;border:1px solid #e7e0f3;border-radius:12px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 30px;background:#6b4eff;color:#fff;border-radius:12px 12px 0 0"><div style="font-size:25px;font-weight:bold">UpCheck</div><div style="margin-top:8px;font-size:14px">제출서류 보완 안내</div></td></tr><tr><td style="padding:28px 30px;font-size:14px;line-height:1.9"><p style="margin-top:0">안녕하세요.<br>등록된 안내문을 기준으로 제출서류를 점검했습니다.<br>아래 항목을 확인해 보완해 주세요.</p>'+section('누락된 서류',r.missing_documents)+section('중복된 서류',r.duplicate_documents)+'<div style="margin:26px 0;padding:18px;background:#f4f0ff;border-radius:8px"><strong>보완 방법</strong><br>이 메일에 답장으로 보완 파일을 첨부해 주세요.<br>같은 파일명은 최신 파일로 대체하며, 다른 파일명은 기존 서류에 추가해 재점검합니다.</div><p style="font-size:12px;color:#62586f">PDF 내용 사전 점검 결과입니다. 한글 원본 내용 일치, 서명 진위, 선발 자격과 최종 접수 여부는 담당자가 확인합니다.</p><div style="border-top:1px solid #eee8f5;padding-top:18px;font-size:12px;color:#71677d"><strong>개인정보 처리 안내</strong><br>제출 문서는 누락·중복 대조를 위해 Upstage AI로 전송됩니다. 작성자 이름은 안내 메일에서 일부 가려 표시하며, 원문·연락처·서명 이미지는 첨부하지 않습니다. 원문과 실행 결과의 보관·삭제는 서비스별 정책 및 기관 운영 기준에 따라 관리합니다. 관련 문의는 이 메일의 담당자에게 답장해 주세요.</div></td></tr></table></td></tr></table></body></html>';
}
