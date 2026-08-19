'use strict';
const $=(id)=>document.getElementById(id);
const API_BASE=location.hostname.endsWith('.kommunsign.se')||location.hostname==='kommunsign.se'?'https://api.kommunsign.se':'http://127.0.0.1:8787';
const query=new URL(location.href).searchParams;
let invitationToken=query.get('token')||'';
let session=null;
let pollTimer=null;
if(invitationToken)history.replaceState(null,'',`${location.pathname}${location.hash}`);

function show(id,visible=true){$(id).classList.toggle('hidden',!visible);}
function setStatus(id,message,type=''){const node=$(id);node.textContent=message;node.className=`status ${type}`.trim();}
async function api(path,options={}){
  const response=await fetch(`${API_BASE}${path}`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',...options,headers:{accept:'application/json',...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})}});
  const contentType=response.headers.get('content-type')||'';
  const payload=contentType.includes('application/json')?await response.json().catch(()=>({})):null;
  if(!response.ok)throw new Error(payload?.error?.code||`HTTP_${response.status}`);
  return payload;
}
function invitationPath(suffix=''){return `/v1/public/signing-invitations/${encodeURIComponent(invitationToken)}${suffix}`;}
function formatDate(value){return new Intl.DateTimeFormat('sv-SE',{dateStyle:'long',timeStyle:'short',timeZone:'Europe/Stockholm'}).format(new Date(value));}
function bindingLabel(mode){return mode==='STRICT_PREBOUND'?'Personnummer förhandsbundet och kontrolleras mot BankID':'Identiteten fastställs av BankID enligt dokumenterat undantag';}
function statusMessage(value){return({PENDING:'Väntar på BankID.',USER_ACTION_REQUIRED:'Fortsätt i BankID-appen.',COMPLETED:'BankID är slutfört. Beviset samlas in och verifieras.',CANCELLED:'BankID-sessionen har avbrutits.',EXPIRED:'BankID-sessionen har gått ut.',FAILED:'BankID kunde inte slutföras.'})[value]||'Väntar på BankID.';}
function createDocumentCard(item){
  const article=document.createElement('article');article.className='document-item';
  const heading=document.createElement('h3');heading.textContent=`${item.ordinal}. ${item.displayName}`;
  const meta=document.createElement('p');meta.className='muted';meta.textContent=`${item.profile} · ${new Intl.NumberFormat('sv-SE').format(item.byteSize)} byte`;
  const hash=document.createElement('code');hash.textContent=item.sha256;
  const link=document.createElement('a');link.className='button-link';link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';link.href=`${API_BASE}${invitationPath(`/documents/${encodeURIComponent(item.id)}`)}`;link.textContent='Öppna exakt handling';
  article.append(heading,meta,window.document.createTextNode('SHA-256: '),hash,link);return article;
}
async function loadInvitation(){
  if(!/^[A-Za-z0-9_-]{43,512}$/.test(invitationToken)){setStatus('status','Inbjudningslänken saknas eller är ogiltig.','error');return;}
  try{
    const data=await api(invitationPath());
    $('brand').textContent=data.organizationName;
    $('organization').textContent=data.organizationName;
    $('case-title').textContent=data.caseTitle;
    $('case-reference').textContent=data.caseReference;
    $('signer-name').textContent=data.signerDisplayName;
    $('binding-mode').textContent=bindingLabel(data.identifierBindingMode);
    $('expires-at').textContent=formatDate(data.expiresAt);
    $('visible-data').textContent=data.visibleText;
    $('documents').replaceChildren(...data.documents.map(createDocumentCard));
    show('loading-card',false);show('invitation');
    await api(invitationPath('/opened'),{method:'POST',body:'{}'});
  }catch(error){setStatus('status',`Inbjudan kunde inte öppnas: ${error.message}. Kontakta avsändaren om du behöver en ny länk.`,'error');}
}
$('reviewed').addEventListener('change',()=>{$('start').disabled=!$('reviewed').checked;setStatus('action-status',$('reviewed').checked?'Du kan nu starta BankID.':'Granska handlingarna och markera bekräftelsen.',$('reviewed').checked?'success':'');});
$('start').addEventListener('click',async()=>{
  $('start').disabled=true;setStatus('action-status','Skapar säker BankID-session.');
  try{session=await api(invitationPath('/bankid/start'),{method:'POST',body:JSON.stringify({reviewAcknowledged:true})});show('bankid-panel');renderSession(session);startPolling();$('bankid-panel').scrollIntoView({behavior:'smooth',block:'start'});}catch(error){$('start').disabled=false;setStatus('action-status',`BankID kunde inte startas: ${error.message}.`,'error');}
});
function renderSession(value){
  session=value;
  setStatus('bankid-status',statusMessage(value.status),value.status==='COMPLETED'?'success':['FAILED','CANCELLED','EXPIRED'].includes(value.status)?'error':'');
  if(value.qrCodeData){try{window.KommunsignQr.renderSvg($('qr'),value.qrCodeData);}catch{$('qr').textContent='QR-koden kunde inte renderas.';}}
  $('same-device').disabled=!value.autoStartToken;
  $('same-device').dataset.token=value.autoStartToken||'';
  $('extend').disabled=!value.canExtend||['COMPLETED','FAILED','CANCELLED','EXPIRED'].includes(value.status);
  if(value.status==='COMPLETED'){stopPolling();show('invitation',false);show('bankid-panel',false);show('completed');}
  if(['FAILED','CANCELLED','EXPIRED'].includes(value.status))stopPolling();
}
// Polling ran until the tab closed. A signer who walks away leaves a tab asking the API for status
// every two seconds indefinitely, and each of those costs two database transactions plus an
// outbound call to BankID. Polling past the session's own expiry cannot tell us anything new, so it
// stops there; a hard ceiling covers a session whose expiry never arrives.
const MAXIMUM_POLL_MILLISECONDS=15*60*1000;
function sessionExpired(){
  if(!session||!session.expiresAt)return false;
  const expiresAt=new Date(session.expiresAt).getTime();
  return Number.isFinite(expiresAt)&&Date.now()>expiresAt;
}
function startPolling(){
  stopPolling();
  const startedAt=Date.now();
  pollTimer=setInterval(async()=>{
    if(!session)return;
    if(sessionExpired()||Date.now()-startedAt>MAXIMUM_POLL_MILLISECONDS){
      stopPolling();
      setStatus('bankid-status','BankID-sessionen har gått ut. Starta om underskriften för att försöka igen.','error');
      return;
    }
    try{renderSession(await api(invitationPath(`/bankid/sessions/${encodeURIComponent(session.sessionId)}`)));}
    catch(error){setStatus('bankid-status',`Status kunde inte hämtas: ${error.message}. Ett nytt försök görs.`, 'error');}
  },2000);
}
function stopPolling(){if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}
$('same-device').addEventListener('click',()=>{const token=$('same-device').dataset.token;if(token)location.href=`bankid:///?autostarttoken=${encodeURIComponent(token)}&redirect=null`;});
$('extend').addEventListener('click',async()=>{if(!session)return;$('extend').disabled=true;try{renderSession(await api(invitationPath(`/bankid/sessions/${encodeURIComponent(session.sessionId)}/extend`),{method:'POST',body:'{}'}));}catch(error){setStatus('bankid-status',`Sessionen kunde inte förlängas: ${error.message}.`,'error');}});
$('cancel').addEventListener('click',async()=>{if(!session)return;try{await api(invitationPath(`/bankid/sessions/${encodeURIComponent(session.sessionId)}`),{method:'DELETE'});stopPolling();setStatus('bankid-status','BankID-sessionen har avbrutits.','error');}catch(error){setStatus('bankid-status',`Sessionen kunde inte avbrytas: ${error.message}.`,'error');}});
$('decline').addEventListener('click',()=>$('decline-dialog').showModal());
$('decline-form').addEventListener('submit',async(event)=>{if(event.submitter?.value!=='confirm')return;event.preventDefault();try{await api(invitationPath('/decline'),{method:'POST',body:JSON.stringify({reason:$('decline-reason').value.trim()||undefined})});$('decline-dialog').close();show('invitation',false);show('bankid-panel',false);show('loading-card');setStatus('status','Du har avböjt underskriften. Avsändaren har informerats.','success');}catch(error){setStatus('action-status',`Avböjningen kunde inte registreras: ${error.message}.`,'error');}});
window.addEventListener('pagehide',stopPolling);
loadInvitation();
