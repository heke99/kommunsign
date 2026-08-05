const API_BASE = globalThis.KOMMUNSIGN_API_BASE || ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'http://127.0.0.1:8787' : 'https://api.kommunsign.se');
const state = { applicationId: sessionStorage.getItem('kommunsign.applicationId'), accessToken: sessionStorage.getItem('kommunsign.accessToken'), application: null };
const $ = (selector) => document.querySelector(selector);
const notice = (message) => { $('#notice').textContent = message; };
const key = () => `onboarding-ui-${crypto.randomUUID()}`;
async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', 'x-request-id': crypto.randomUUID(), ...(options.headers || {}) };
  if (state.accessToken) headers.authorization = `Bearer ${state.accessToken}`;
  if (options.mutating) headers['idempotency-key'] = key();
  if (options.version) headers['if-match'] = String(options.version);
  const response = await fetch(`${API_BASE}${path}`, { method: options.method || 'GET', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.code || `HTTP_${response.status}`);
  return payload;
}
function render(application) {
  state.application = application;
  $('#workspace').classList.remove('hidden');
  $('#application-id').textContent = application.id;
  $('#application-reference').textContent = application.applicationReference || 'Tilldelas vid inskick';
  $('#updated-at').textContent = new Date(application.updatedAt).toLocaleString('sv-SE');
  $('#status-badge').textContent = application.status;
  $('#connection-status').textContent = `Ansluten: ${application.organizationName}`;
  $('#verification-panel').classList.toggle('hidden', application.status !== 'email_verification_pending');
  $('#submit-application').disabled = !['email_verified','resubmitted'].includes(application.status);
  const profile = application.profile || {};
  const deployment = profile.deployment || {};
  const profileForm = $('#profile-form');
  profileForm.elements.website.value = profile.website || '';
  profileForm.elements.officialEmailDomain.value = profile.officialEmailDomain || '';
  profileForm.elements.municipalityOrRegion.value = profile.municipalityOrRegion || '';
  profileForm.elements.mode.value = deployment.mode || 'shared_saas';
  profileForm.elements.region.value = deployment.region || 'se-central';
  profileForm.elements.classification.value = deployment.classification || 'INTERNAL';
  profileForm.querySelectorAll('input,select,button').forEach((element) => { element.disabled = !['draft','email_verification_pending','email_verified','additional_information_requested','resubmitted'].includes(application.status); });
}
async function refresh() {
  if (!state.applicationId || !state.accessToken) return;
  render(await api(`/v1/onboarding/applications/${state.applicationId}`));
  const [messages, requests] = await Promise.all([api(`/v1/onboarding/applications/${state.applicationId}/messages`), api(`/v1/onboarding/applications/${state.applicationId}/information-requests`)]);
  $('#message-list').replaceChildren(...messages.map((message) => { const item=document.createElement('li'); item.textContent=`${message.direction === 'applicant_to_platform' ? 'Du' : 'KommunSign'}: ${message.body}`; return item; }));
  $('#information-requests').replaceChildren(...requests.map((request) => { const wrapper=document.createElement('article'); const title=document.createElement('h4'); title.textContent=`Komplettering: ${request.category}`; const text=document.createElement('p'); text.textContent=request.question; wrapper.append(title,text); if(request.status==='open'){const form=document.createElement('form');const label=document.createElement('label');label.textContent='Svar';const textarea=document.createElement('textarea');textarea.required=true;textarea.rows=3;const button=document.createElement('button');button.textContent='Skicka komplettering';form.append(label,button);label.append(textarea);form.addEventListener('submit',async(event)=>{event.preventDefault();await api(`/v1/onboarding/information-requests/${request.id}/responses`,{method:'POST',mutating:true,body:{applicationId:state.applicationId,answer:textarea.value}});notice('Kompletteringen skickades.');await refresh();});wrapper.append(form);} return wrapper; }));
}
$('#application-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const data=Object.fromEntries(new FormData(event.currentTarget));
  try { const created=await api('/v1/onboarding/applications',{method:'POST',mutating:true,body:data}); state.applicationId=created.application.id;state.accessToken=created.accessToken;sessionStorage.setItem('kommunsign.applicationId',state.applicationId);sessionStorage.setItem('kommunsign.accessToken',state.accessToken);render(created.application);if(created.developmentVerificationToken){$('#verification-form [name="token"]').value=created.developmentVerificationToken;notice('Utvecklingsruntime: verifieringstoken har fyllts i automatiskt.');} } catch(error){notice(`Ansökan kunde inte skapas: ${error.message}`);}
});
$('#verification-form').addEventListener('submit',async(event)=>{event.preventDefault();try{const token=new FormData(event.currentTarget).get('token');render(await api(`/v1/onboarding/applications/${state.applicationId}/verify-email`,{method:'POST',mutating:true,body:{token}}));notice('E-postadressen är verifierad.');}catch(error){notice(`Verifieringen misslyckades: ${error.message}`);}});
$('#profile-form').addEventListener('submit',async(event)=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.currentTarget));const profile={website:data.website||undefined,officialEmailDomain:data.officialEmailDomain||undefined,municipalityOrRegion:data.municipalityOrRegion||undefined,deployment:{mode:data.mode,region:data.region||undefined,classification:data.classification||undefined}};try{render(await api(`/v1/onboarding/applications/${state.applicationId}`,{method:'PATCH',mutating:true,version:state.application.statusVersion,body:{profile}}));notice('Profilen sparades.');}catch(error){notice(`Profilen kunde inte sparas: ${error.message}`);}});
$('#submit-application').addEventListener('click',async()=>{try{render(await api(`/v1/onboarding/applications/${state.applicationId}/submit`,{method:'POST',mutating:true,version:state.application.statusVersion}));notice('Ansökan har skickats in.');}catch(error){notice(`Ansökan kunde inte skickas in: ${error.message}`);}});
$('#withdraw-application').addEventListener('click',async()=>{try{render(await api(`/v1/onboarding/applications/${state.applicationId}/withdraw`,{method:'POST',mutating:true,version:state.application.statusVersion}));notice('Ansökan har återkallats.');}catch(error){notice(`Ansökan kunde inte återkallas: ${error.message}`);}});
$('#message-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget,body=new FormData(form).get('body');try{await api(`/v1/onboarding/applications/${state.applicationId}/messages`,{method:'POST',mutating:true,body:{body}});form.reset();notice('Meddelandet skickades.');await refresh();}catch(error){notice(`Meddelandet kunde inte skickas: ${error.message}`);}});
refresh().catch((error)=>notice(`Den sparade sessionen kunde inte återställas: ${error.message}`));
