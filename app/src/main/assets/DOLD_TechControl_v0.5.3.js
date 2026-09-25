/* DOLD TechControl 0.5.3. Keeps the existing JSZip workbook editor and native QR scanner.
 * A save is acknowledged only after one atomic, complete native workspace commit.
 */
const TC = {schema:1, dbId:null, registryKey:'', registryTokens:[], cycle:null,
  guard:null, revision:0, updatedAt:null, sourceHash:'', ready:false, busy:false,
  records:[], allDefects:[], pending:null, opened:null, exportPending:false, baseWorkbookBase64:'',
  sync:null, deviceId:'', pendingSyncRowIds:null, pendingSemanticRows:null,
  startupLoaded:false, activated:false, startupTask:null, startupError:''};
const META_NAME='DOLD.TechControl.v1';
const WORK_PACKAGE_MIME='application/zip';
const APP_VERSION='0.5.5';
const cloneData=v=>JSON.parse(JSON.stringify(v));
let appDialogResolve=null;
function cloneWorkbook(zip){const copy=zip.clone();copy.files={...zip.files};return copy;}
function uid(){const a=new Uint32Array(4);crypto.getRandomValues(a);return [...a].map(n=>n.toString(16).padStart(8,'0')).join('');}
function installationDeviceId(){
  const key='dold_techcontrol_device_id_v1';let id='';
  try{id=localStorage.getItem(key)||'';if(!/^device-[a-f0-9]{32}$/.test(id)){id='device-'+uid();localStorage.setItem(key,id);}}catch(e){id='device-'+uid();}
  return id;
}
function newSyncState(){return {schema:1,epoch:uid(),entities:{Kontroll:{},Puudus:{},Cabinet:{}},journal:[],appliedOps:[],conflicts:[],peerAcks:{},deviceSequences:{},sequence:0};}
function syncFieldString(v){return String(v??'').trim();}
function syncControlBase(r){return [r.id,r.date,r.inspector,String(r.start??'')].map(syncFieldString).join('|');}
function syncDefectBase(d){return [d.id,d.date,d.inspector,d.point].map(syncFieldString).join('|');}
function syncControlValues(r){
  const c=S.cabinets.find(x=>x.id===r.id),values={cabinetId:r.id,date:r.date,area:c?.area||'',inspector:r.inspector,panel:c?.panel||'',device:c?.device||'',location:c?.location||'',start:r.start||'',end:r.end||'',duration:r.duration||0,exception:r.exception||''};
  for(const [col] of CHECKS)values['score_'+col]=r.ratings?.[col]||'';
  const link=TC.cycle?.entries?.[r.id];if(link&&(link.fingerprint===recordFingerprint(r)||link.additionalKontrollIds?.includes(r.syncId))){values.cycleId=TC.cycle.id;if(link.fingerprint===recordFingerprint(r))values.note=link.note||'';}
  return values;
}
function syncDefectValues(d){
  const values={cabinetId:d.id,date:d.date,inspector:d.inspector,cabinetTitle:d.cabinetTitle||'',location:d.location||'',point:d.point||'',description:d.desc||'',priority:d.grade||'',repeat:d.repeat||'',owner:d.owner||'',due:d.due||'',repairer:d.repairer||'',closedAt:d.closedAt||'',repairAction:d.repairAction||'',lastCheckedBy:d.lastCheckedBy||''};
  const link=TC.cycle?.entries?.[d.id],priorControlId=Object.entries(link?.previousControlDefects||{}).find(([,rows])=>rows?.includes(d.row))?.[0];
  const controlId=link?.defectRows?.includes(d.row)?(link.kontrollId||TC.records.find(r=>r.row===link.row&&r.id===d.id&&recordFingerprint(r)===link.fingerprint)?.syncId):priorControlId;
  if(link&&controlId){values.cycleId=TC.cycle.id;values.kontrollId=controlId;}
  return values;
}
function syncCabinetValues(c){return {cabinetId:c.id,status:c.status||''};}
function syncCanonical(v){return JSON.stringify(v);}
async function ensureSyncState(){
  if(!TC.dbId)return;
  TC.deviceId=installationDeviceId();
  if(!TC.sync||TC.sync.schema!==1||TC.sync.dbId!==TC.dbId){TC.sync={...newSyncState(),dbId:TC.dbId};}
  TC.sync.entities??={Kontroll:{},Puudus:{},Cabinet:{}};for(const t of ['Kontroll','Puudus','Cabinet'])TC.sync.entities[t]??={};
  TC.sync.journal=Array.isArray(TC.sync.journal)?TC.sync.journal:[];TC.sync.appliedOps=Array.isArray(TC.sync.appliedOps)?TC.sync.appliedOps:[];TC.sync.conflicts=Array.isArray(TC.sync.conflicts)?TC.sync.conflicts:[];TC.sync.peerAcks=TC.sync.peerAcks&&typeof TC.sync.peerAcks==='object'?TC.sync.peerAcks:{};TC.sync.deviceSequences=TC.sync.deviceSequences&&typeof TC.sync.deviceSequences==='object'?TC.sync.deviceSequences:{};TC.sync.sequence=Math.max(0,Number(TC.sync.sequence)||0);
  const assign=async(type,items,baseOf,valuesOf)=>{
    const entities=TC.sync.entities[type],used=new Set(),groups=new Map();
    for(const item of items){const base=baseOf(item),list=groups.get(base)||[];list.push(item);groups.set(base,list);}
    for(const [base,list] of groups){
      list.sort((a,b)=>syncCanonical(valuesOf(a)).localeCompare(syncCanonical(valuesOf(b))));
      for(let i=0;i<list.length;i++){
        const item=list[i],row=String(item.row),pending=TC.pendingSyncRowIds?.[type]?.[row];
        let key=base+'#'+(i+1),entityId=pending||Object.keys(entities).find(id=>!used.has(id)&&entities[id]?.key===key);
        if(entityId&&used.has(entityId))entityId=null;
        if(!entityId&&TC.pendingSyncRowIds)entityId=`dtc-${type.toLowerCase()}-new-${TC.deviceId.slice(-8)}-${uid()}`;
        if(!entityId){const seed=`${TC.dbId}|${type}|${key}`;entityId=`dtc-${type.toLowerCase()}-${(await digest(new TextEncoder().encode(seed))).slice(0,32)}`;if(used.has(entityId)){let n=i+1;do{key=base+'#'+(++n);entityId=`dtc-${type.toLowerCase()}-${(await digest(new TextEncoder().encode(`${TC.dbId}|${type}|${key}`))).slice(0,32)}`;}while(used.has(entityId));}}
        const old=entities[entityId]||{};entities[entityId]={...old,key,fieldVersions:old.fieldVersions||{},values:valuesOf(item)};used.add(entityId);item.syncId=entityId;
      }
    }
  };
  await assign('Kontroll',TC.records,syncControlBase,syncControlValues);
  for(const [cabinetId,link] of Object.entries(TC.cycle?.entries||{})){
    const r=TC.records.find(x=>x.syncId&&x.id===cabinetId&&((x.row===link.row&&(!link.fingerprint||recordFingerprint(x)===link.fingerprint))||(link.fingerprint&&recordFingerprint(x)===link.fingerprint)));
    if(r)link.kontrollId=r.syncId;
  }
  await assign('Puudus',TC.allDefects,syncDefectBase,syncDefectValues);
  await assign('Cabinet',S.cabinets,c=>c.id,syncCabinetValues);
  if(TC.pendingSyncRowIds)TC.pendingSyncRowIds=null;
}
function nativeStore(){return !!(window.Android&&typeof Android.saveWorkspace==='function');}
async function digest(bytes){
  if(nativeStore()&&typeof Android.hashBytes==='function')return Android.hashBytes(bytesToBase64(bytes));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function decode64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function browserDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open('dold-workspaces-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('workspaces',{keyPath:'dbId'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function storeCall(kind,value){
  if(nativeStore()){
    const raw=kind==='list'?Android.listWorkspaces():kind==='get'?Android.readWorkspace(value):Android.saveWorkspace(value.dbId,JSON.stringify(value));
    const result=JSON.parse(raw);if(!result.ok)throw Error(result.error||'Sisemine salvestamine ebaõnnestus');return result.data;
  }
  const db=await browserDb();return new Promise((resolve,reject)=>{
    let tx;try{tx=db.transaction('workspaces',kind==='put'?'readwrite':'readonly',{durability:'strict'});}catch(e){tx=db.transaction('workspaces',kind==='put'?'readwrite':'readonly');}
    const os=tx.objectStore('workspaces'),r=kind==='list'?os.getAll():kind==='get'?os.get(value):os.put(value);
    tx.oncomplete=()=>{db.close();resolve(kind==='put'?true:r.result);};tx.onabort=tx.onerror=()=>{db.close();reject(tx.error||Error('Andmeid ei salvestatud'));};
  });
}
function appDialogChoice(value){if(!appDialogResolve)return;const done=appDialogResolve;appDialogResolve=null;$('appDialog')?.classList.add('hidden');done(value);}
function showAppChoice(title,body,actions){
  const box=$('appDialog');if(!box){const ok=confirm(title+'\n\n'+body);return Promise.resolve(ok?actions[0]?.value:null);}
  $('appDialogTitle').textContent=title;$('appDialogBody').innerHTML=body;
  $('appDialogActions').innerHTML=actions.map((a,i)=>`<button id="appDialogChoice${i}" class="${a.primary?'primary':''}" onclick="appDialogChoice('${a.value}')">${esc(a.label)}</button>`).join('');
  box.classList.remove('hidden');return new Promise(resolve=>{appDialogResolve=resolve;});
}
function localDateTime(value){const d=value?new Date(value):null;return d&&!Number.isNaN(d.getTime())?d.toLocaleString('et-EE'): 'puudub';}
function excelClock(value){const s=String(value??'').trim();const m=s.match(/(?:T|\s)(\d{1,2}:\d{2}(?::\d{2})?)/);if(m)return m[1].length===5?m[1]+':00':m[1];const n=Number(s);if(!Number.isFinite(n)||n===0)return '';const f=((n%1)+1)%1,total=Math.round(f*86400)%86400;return String(Math.floor(total/3600)).padStart(2,'0')+':'+String(Math.floor(total%3600/60)).padStart(2,'0')+':'+String(total%60).padStart(2,'0');}
function localCycleStamp(date=new Date()){const p=n=>String(n).padStart(2,'0');return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;}
function realStartFromRecord(r){
  const raw=String(r.start??'').trim();if(!raw)return null;
  let date=String(r.date||'').slice(0,10),time='';
  const iso=raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2})?)/);if(iso)return `${iso[1]}T${iso[2].length===5?iso[2]+':00':iso[2]}`;
  const localized=raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)/);if(localized){date=`${localized[3]}-${String(localized[2]).padStart(2,'0')}-${String(localized[1]).padStart(2,'0')}`;time=localized[4];}
  else{
    const n=Number(raw);
    if(Number.isFinite(n)&&n>=1){const d=new Date(Date.UTC(1899,11,30)+n*86400000);const p=v=>String(v).padStart(2,'0');date=`${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`;time=`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;}
    else if(Number.isFinite(n)&&n>0&&n<1)time=excelClock(n);
    else time=excelClock(raw);
  }
  if(!date||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!time)return null;
  return `${date}T${time.length===5?time+':00':time}`;
}
function cycleStartFromRecords(records,fallback){
  const starts=records.map(realStartFromRecord).filter(Boolean).sort();if(starts.length)return starts[0];
  const dates=records.map(r=>String(r.date||'').slice(0,10)).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)).sort();if(dates.length)return dates[0];
  if(fallback){const parsed=new Date(String(fallback));if(!Number.isNaN(parsed.getTime())&&(parsed.getHours()||parsed.getMinutes()||parsed.getSeconds()))return localCycleStamp(parsed);}
  return null;
}
function cycleStartLabel(cycle){
  const linked=[];for(const [id,link] of Object.entries(cycle?.entries||{})){const r=TC.records.find(x=>x.id===id&&((x.row===link.row&&(!link.fingerprint||recordFingerprint(x)===link.fingerprint))||(link.fingerprint&&recordFingerprint(x)===link.fingerprint)));if(r)linked.push(r);}
  const stored=String(cycle?.startedAt||''),d=stored?new Date(stored):null,storedMidnight=!!(d&&!Number.isNaN(d.getTime())&&d.getHours()===0&&d.getMinutes()===0&&d.getSeconds()===0);
  if(cycle?.startSource==='records'||(!cycle?.startSource&&linked.length&&storedMidnight)){
    const actual=cycleStartFromRecords(linked,null);if(actual)return actual.length>10?`${actual.slice(8,10)}.${actual.slice(5,7)}.${actual.slice(0,4)} ${actual.slice(11,19)}`:`${actual.slice(8,10)}.${actual.slice(5,7)}.${actual.slice(0,4)} (kellaaeg puudub)`;
  }
  const raw=stored;if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return `${raw.slice(8,10)}.${raw.slice(5,7)}.${raw.slice(0,4)}`;
  const parsed=raw?new Date(raw):null;if(!parsed||Number.isNaN(parsed.getTime()))return 'kuupäev puudub';
  const p=n=>String(n).padStart(2,'0'),date=`${p(parsed.getDate())}.${p(parsed.getMonth()+1)}.${parsed.getFullYear()}`,midnight=parsed.getHours()===0&&parsed.getMinutes()===0&&parsed.getSeconds()===0;
  if(linked.length&&midnight)return `${date} (kellaaeg puudub)`;
  return parsed.toLocaleString('et-EE');
}
function captureWorkspaceSummary(meta={}){
  const active=activeCabinets(),checked=active.filter(c=>S.sessionChecked.has(c.id)).length;
  const latest=[...TC.records].filter(r=>r.date).sort((a,b)=>{
    const ak=rSortKey(a),bk=rSortKey(b);return bk-ak;
  })[0];
  const stamp=latest?`${latest.date}${excelClock(latest.end||latest.start)?' '+excelClock(latest.end||latest.start):''}`:'';
  return {controlCount:TC.records.length,defectCount:TC.allDefects.length,openDefects:S.existingDefects.length,activeCount:active.length,checkedCount:checked,latestInspection:stamp,latestInspectionKey:latest?rSortKey(latest):0,updatedAt:Object.hasOwn(meta,'updatedAt')?meta.updatedAt:(TC.updatedAt??null),revision:Object.hasOwn(meta,'revision')?meta.revision:(TC.revision??0)};
}
function rSortKey(r){const date=String(r.date||'');const time=excelClock(r.end||r.start);const ms=Date.parse(date+(time?'T'+time+'Z':'T00:00:00Z'));return Number.isFinite(ms)?ms:0;}
function freshnessRelation(local,embedded,localSummary,incomingSummary,externalIsOriginal){
  if(externalIsOriginal&&local.dirty)return 'internal';
  if(embedded?.dbId===local.dbId){const lr=Number(local.revision)||0,er=Number(embedded.revision)||0;if(er>lr)return 'incoming';if(lr>er)return 'internal';const lm=Date.parse(local.updatedAt||''),em=Date.parse(embedded.updatedAt||'');if(Number.isFinite(lm)&&Number.isFinite(em)&&lm!==em)return lm>em?'internal':'incoming';}
  const axes=['controlCount','defectCount','latestInspectionKey','checkedCount'];
  const deltas=axes.map(k=>(Number(localSummary?.[k])||0)-(Number(incomingSummary?.[k])||0));
  if(deltas.every(x=>x>=0)&&deltas.some(x=>x>0))return 'internal';
  if(deltas.every(x=>x<=0)&&deltas.some(x=>x<0))return 'incoming';
  if(deltas.every(x=>x===0)&&externalIsOriginal)return 'same';
  return 'ambiguous';
}
function summaryBlock(title,s){return `<b>${esc(title)}</b><br>Kontrollid: ${Number(s?.controlCount)||0} • Puudused: ${Number(s?.openDefects)||0} avatud / ${Number(s?.defectCount)||0} kokku<br>Kontroll: ${Number(s?.checkedCount)||0} / ${Number(s?.activeCount)||0}<br>Viimane kontroll: ${esc(s?.latestInspection||'puudub')}<br>Viimane muudatus: ${esc(localDateTime(s?.updatedAt))}`;}
async function showWorkspaceComparison(local,embedded,localSummary,incomingSummary,externalIsOriginal){
  const relation=freshnessRelation(local,embedded,localSummary,incomingSummary,externalIsOriginal);
  const message=relation==='internal'?'Telefonis olev tööfail on uuem.':relation==='incoming'?'Valitud tööfail näib uuem.':relation==='same'?'Andmed kattuvad.':'Versioonide järjestus ei ole kindel. Kontrolli mõlemat kokkuvõtet.';
  const buttons=[{value:'internal',label:'JÄTKA TELEFONI TÖÖGA',primary:true}];
  if(relation!=='same')buttons.push({value:'merge',label:'ÜHENDA, KUI OHUTU'});
  buttons.push({value:'incoming',label:relation==='internal'?'KASUTA SIISKI VALITUD FAILI':'KASUTA VALITUD FAILI'});
  buttons.push({value:'cancel',label:'TÜHISTA'});
  return showAppChoice('Võrdle tööfaile',`<b>${esc(message)}</b><div class="topgap">${summaryBlock('TELEFONIS',localSummary)}</div><div class="topgap">${summaryBlock('VALITUD FAIL',incomingSummary)}</div><p class="topgap">Telefonis olevat tööd ei asendata enne sinu valikut.</p>`,buttons);
}
function renderStartupWorkspace(){
  const host=$('startupWorkspaceList');if(!host)return;
  if(!TC.startupLoaded){host.innerHTML=TC.startupError?`<div class="badge warn">Telefonis oleva tööfaili kontroll ebaõnnestus</div><p>${esc(TC.startupError)}</p><p>Vali töö jätkamiseks või uue faili avamiseks XLSX.</p>`:'<div class="small">Telefonis pole veel salvestatud tööfaili. Vali alustamiseks XLSX.</div>';return;}
  const s=captureWorkspaceSummary({updatedAt:TC.updatedAt,revision:TC.revision});
  host.innerHTML=`${TC.startupWarning?`<div class="badge warn">${esc(TC.startupWarning)}</div>`:''}<div><b>Aktiivne tööfail:</b><br>${esc(S.fileName)}</div><div class="small topgap">Kontroll: ${s.checkedCount} / ${s.activeCount}<br>Puudused: ${s.openDefects}<br>Viimane kontroll: ${esc(s.latestInspection||'puudub')}<br>Viimane muudatus: ${esc(localDateTime(s.updatedAt))}</div>${TC.activated?'<div class="badge ok topgap">Tööfail on avatud</div>':'<button class="primary topgap" onclick="continueLastWorkingFile()">JÄTKA VIIMASE TÖÖFAILIGA</button>'}`;
}
function selectNewWorkbook(){const card=$('workbookImportCard'),input=$('xlsxFileInput');card?.classList.remove('hidden');input?.click();}
function handleImportFile(ev){const file=ev.target.files?.[0];if(!file)return;if(/\.dtcs$/i.test(file.name)){if(typeof importSyncPackage==='function')importSyncPackage(ev);else alert('Sünkroonimispaketi vastuvõtt pole saadaval.');return;}if(/\.dtc$/i.test(file.name)){if(typeof importWorkPackage==='function')importWorkPackage(ev);else alert('Tööpaketi vastuvõtt pole saadaval.');return;}importXlsx(ev);}
async function bootstrapSavedWorkspace(){
  try{
    const listed=await storeCall('list');const list=Array.isArray(listed)?listed:[];
    let issues=[];if(nativeStore()&&typeof Android.listWorkspaceErrors==='function'){try{const raw=JSON.parse(Android.listWorkspaceErrors());if(raw.ok&&Array.isArray(raw.data))issues=raw.data;}catch(e){issues=[];}}
    if(!list.length){TC.startupLoaded=false;TC.startupError=issues.length?'Telefonis olev tööfail on vigane. Vali töö jätkamiseks uuesti XLSX.':'';renderStartupWorkspace();return;}
    TC.startupWarning=issues.length?'Mõnda telefoni salvestatud tööfaili ei saanud avada; saad jätkata viimase terve koopiaga.':'';
    const latest=[...list].sort((a,b)=>(Date.parse(b.lastUsedAt||b.updatedAt||'')||Number(b.revision)||0)-(Date.parse(a.lastUsedAt||a.updatedAt||'')||Number(a.revision)||0))[0];
    const snap=await storeCall('get',latest.dbId);if(!snap||snap.schema!==1||!snap.workbookBase64)throw Error('Sisemine XLSX töövihik puudub või on vigane.');
    const bytes=decode64(snap.workbookBase64);if(snap.workbookHash&&await digest(bytes)!==snap.workbookHash)throw Error('Sisemise XLSX faili kontrollsumma ei klapi.');
    Object.assign(TC,{dbId:snap.dbId,registryKey:snap.registryKey||'',registryTokens:snap.registryTokens||[],cycle:snap.cycle||null,sync:snap.sync||null,guard:snap.guard||{remaining:randomGap(),pending:null},revision:Number(snap.revision)||0,updatedAt:snap.updatedAt||null,localUsedAt:snap.lastUsedAt||snap.updatedAt||null,sourceHash:snap.sourceHash||'',baseWorkbookBase64:snap.baseWorkbookBase64||'',ready:false,opened:null,pending:{notice:'Taastatud telefoni salvestatud tööfail.'}});
    S.inspector=snap.inspector||'';S.dirty=!!snap.dirty;await loadBook(bytes,snap.fileName||'DOLD_TechControl.xlsx');TC.startupLoaded=true;TC.activated=false;TC.startupError='';loadMinInspectionSetting();renderStartupWorkspace();
  }catch(e){TC.startupLoaded=false;TC.startupError=e.message||String(e);TC.dbId=null;TC.cycle=null;TC.ready=false;S.zip=null;S.fileName='';S.cabinets=[];S.sessionChecked=new Set();renderStartupWorkspace();}
}
async function continueLastWorkingFile(){if(!TC.startupLoaded){selectNewWorkbook();return;}TC.ready=false;TC.activated=true;$('workTabs').classList.remove('hidden');$('exportBtn').disabled=false;$('shareXlsxBtn').disabled=false;$('sharePackageBtn').disabled=false;$('workbookImportCard').classList.add('hidden');loadMinInspectionSetting();renderStartupWorkspace();renderCyclePanel();showTab('home');}
async function readMetadata(){
  const f=S.zip.file('docProps/custom.xml');if(!f)return null;
  const d=parseXml(await f.async('string')),p=qsa(d,'property').find(x=>x.getAttribute('name')===META_NAME);
  if(!p)return null;try{const m=JSON.parse(p.textContent);return m.schema===1&&m.dbId?m:null;}catch(e){throw Error('Kontrolli metaandmed on vigased. Algfaili ei muudeta.');}
}
async function writeMetadata(){
  const ns='http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',vt='http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
  const path='docProps/custom.xml',f=S.zip.file(path);
  const d=f?parseXml(await f.async('string')):parseXml(`<Properties xmlns="${ns}" xmlns:vt="${vt}"/>`);
  let p=qsa(d,'property').find(x=>x.getAttribute('name')===META_NAME);
  if(!p){p=d.createElementNS(ns,'property');p.setAttribute('fmtid','{D5CDD505-2E9C-101B-9397-08002B2CF9AE}');p.setAttribute('pid',String(Math.max(1,...qsa(d,'property').map(x=>Number(x.getAttribute('pid'))||1))+1));p.setAttribute('name',META_NAME);d.documentElement.appendChild(p);}
  while(p.firstChild)p.removeChild(p.firstChild);
  const v=d.createElementNS(vt,'vt:lpwstr');v.textContent=JSON.stringify({schema:1,dbId:TC.dbId,registryKey:TC.registryKey,cycle:TC.cycle,revision:TC.revision,updatedAt:TC.updatedAt,inspector:S.inspector,sync:TC.sync||null});p.appendChild(v);S.zip.file(path,xmlStr(d));
  const types=parseXml(await S.zip.file('[Content_Types].xml').async('string'));
  if(!qsa(types,'Override').some(x=>x.getAttribute('PartName')==='/'+path)){
    const x=types.createElementNS(types.documentElement.namespaceURI,'Override');x.setAttribute('PartName','/'+path);x.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.custom-properties+xml');types.documentElement.appendChild(x);S.zip.file('[Content_Types].xml',xmlStr(types));
  }
  const rel=parseXml(await S.zip.file('_rels/.rels').async('string'));
  if(!qsa(rel,'Relationship').some(x=>/\/custom-properties$/.test(x.getAttribute('Type')||''))){
    const x=rel.createElementNS(rel.documentElement.namespaceURI,'Relationship');const ids=new Set(qsa(rel,'Relationship').map(x=>x.getAttribute('Id')));let id='rIdDoldControl';while(ids.has(id))id+='1';x.setAttribute('Id',id);x.setAttribute('Type','http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties');x.setAttribute('Target',path);rel.documentElement.appendChild(x);S.zip.file('_rels/.rels',xmlStr(rel));
  }
}
async function registryIdentity(){
  const tokens=S.cabinets.map(c=>[c.id,c.area,c.panel,c.device,c.location].map(v=>String(v||'').trim().toLowerCase()).join('|')).sort();
  return {tokens,key:await digest(new TextEncoder().encode(tokens.join('\n')))};
}
function recordFingerprint(r){return [r.id,r.date,r.inspector,String(r.start)].join('|');}
async function hydrateHistory(ctr,def){
  TC.records=qsa(ctr,'row').map(x=>Number(x.getAttribute('r'))).filter(r=>r>=5&&getCellVal(ctr,'B',r)).map(row=>({row,id:getCellVal(ctr,'B',row).trim(),date:excelDateToIso(getCellVal(ctr,'A',row)),inspector:getCellVal(ctr,'D',row).trim(),start:getCellVal(ctr,'W',row),end:getCellVal(ctr,'X',row),duration:Number(getCellVal(ctr,'Y',row))||0,exception:getCellVal(ctr,'Z',row),ratings:Object.fromEntries(CHECKS.map(([col])=>[col,getCellVal(ctr,col,row)]))}));
  TC.allDefects=qsa(def,'row').map(x=>Number(x.getAttribute('r'))).filter(r=>r>=5&&getCellVal(def,'B',r)).map(row=>({row,id:getCellVal(def,'B',row).trim(),date:excelDateToIso(getCellVal(def,'A',row)),inspector:getCellVal(def,'E',row),cabinetTitle:getCellVal(def,'C',row),location:getCellVal(def,'D',row),point:getCellVal(def,'F',row),desc:getCellVal(def,'G',row),grade:getCellVal(def,'H',row),repeat:getCellVal(def,'I',row),owner:getCellVal(def,'J',row),due:excelDateToIso(getCellVal(def,'K',row)),repairer:getCellVal(def,'L',row),closedAt:getCellVal(def,'M',row),repairAction:getCellVal(def,'O',row),lastCheckedBy:getCellVal(def,'P',row),closed:!!getCellVal(def,'M',row)}));
  for(const c of S.cabinets){
    const latest=TC.records.filter(r=>r.id===c.id&&r.date).sort((a,b)=>b.date.localeCompare(a.date)||b.row-a.row)[0];
    if(latest&&(!c.lastDate||latest.date>=c.lastDate)){c.lastDate=latest.date;c.lastInspector=latest.inspector;/* Keep configured historical interval when available. */if(!c.nextDate||c.nextDate<=latest.date)c.nextDate=plusDays(latest.date,120);}
  }
  S.existingDefects=TC.allDefects.filter(d=>!d.closed);
  reconcileCycle();
}
function reconcileCycle(){
  S.sessionChecked=new Set();if(!TC.cycle)return;
  for(const [id,link] of Object.entries(TC.cycle.entries||{})){
    let r=link.kontrollId?TC.records.find(r=>r.syncId===link.kontrollId&&r.id===id):null;
    if(!r)r=TC.records.find(r=>r.row===link.row&&r.id===id&&(!link.fingerprint||recordFingerprint(r)===link.fingerprint));
    if(!r&&link.fingerprint)r=TC.records.find(r=>r.id===id&&recordFingerprint(r)===link.fingerprint);
    if(r){link.row=r.row;link.fingerprint=recordFingerprint(r);if(r.syncId)link.kontrollId=r.syncId;S.sessionChecked.add(id);}
  }
  S.ringStartedAt=TC.cycle.startedAt;
}
function savedEntry(id){const link=TC.cycle?.entries?.[id];if(!link)return null;return (link.kontrollId&&TC.records.find(r=>r.syncId===link.kontrollId&&r.id===id))||TC.records.find(r=>r.row===link.row&&r.id===id&&recordFingerprint(r)===link.fingerprint)||TC.records.find(r=>r.id===id&&recordFingerprint(r)===link.fingerprint)||null;}
function setBusy(value){TC.busy=value;document.body.classList.toggle('saving',value);}
function semanticState(){
  return {
    Kontroll:new Map(TC.records.filter(r=>r.syncId).map(r=>[r.syncId,syncControlValues(r)])),
    Puudus:new Map(TC.allDefects.filter(d=>d.syncId).map(d=>[d.syncId,syncDefectValues(d)])),
    Cabinet:new Map(S.cabinets.filter(c=>c.syncId).map(c=>[c.syncId,syncCabinetValues(c)]))
  };
}
function semanticAction(type,before,after){
  if(type==='Kontroll')return before?'UPDATE_KONTROLL':'ADD_KONTROLL';
  if(type==='Puudus')return !before?'ADD_PUUDUS':(!before.closedAt&&after.closedAt?'CLOSE_PUUDUS':'UPDATE_PUUDUS');
  return 'UPDATE_CABINET_STATUS';
}
function fieldValueEqual(a,b){return JSON.stringify(a)===JSON.stringify(b);}
async function appendSemanticOperations(beforeState){
  await ensureSyncState();const afterState=semanticState(),ops=[];
  for(const type of ['Kontroll','Puudus','Cabinet']){
    const prior=beforeState[type]||new Map(),current=afterState[type];
    for(const [entityId,after] of current){
      const before=prior.get(entityId)||null,fields={};
      for(const field of new Set([...Object.keys(before||{}),...Object.keys(after||{})]))if(!fieldValueEqual(before?.[field],after?.[field]))fields[field]=after?.[field]??null;
      if(!Object.keys(fields).length)continue;
      const entity=TC.sync.entities[type][entityId]||(TC.sync.entities[type][entityId]={key:'',fieldVersions:{},values:{}}),baseFieldVersions={};
      for(const field of Object.keys(fields))baseFieldVersions[field]=entity.fieldVersions?.[field]||null;
      const localSequence=nextSyncSequence(),opId=`${TC.deviceId}:${localSequence}`;
      const op={schema:1,opId,deviceId:TC.deviceId,localSequence,createdAt:new Date().toISOString(),dbId:TC.dbId,epoch:TC.sync.epoch,entityType:type,entityId,action:semanticAction(type,before,after),baseRevision:Number(entity.revision)||0,baseFieldVersions,changedFields:fields};
      for(const field of Object.keys(fields))entity.fieldVersions[field]=opId;
      entity.values=cloneData(after);entity.revision=(Number(entity.revision)||0)+1;
      TC.sync.journal.push(op);if(!TC.sync.appliedOps.includes(opId))TC.sync.appliedOps.push(opId);ops.push(op);
    }
  }
  return ops;
}
function planSyncOperation(op){
  if(!TC.sync||op?.schema!==1||!op.opId||!op.entityId||!op.entityType)throw Error('Sünkroonimistoiming on vigane.');
  if(op.dbId!==TC.dbId)throw Error('Need tööfailid ei kuulu samasse andmebaasi.');
  if(op.epoch!==TC.sync.epoch)throw Error('Sünkroonimispakett kuulub teise tööbaasi algseisu. Valmista teine telefon uuesti ette.');
  if(!['Kontroll','Puudus','Cabinet'].includes(op.entityType)||!op.changedFields||typeof op.changedFields!=='object')throw Error('Sünkroonimistoimingu sisu ei ole toetatud.');
  if(TC.sync.appliedOps.includes(op.opId))return {duplicate:true,applyFields:{},sameFields:[],conflicts:[]};
  const entity=TC.sync.entities[op.entityType][op.entityId]||{values:{},fieldVersions:{},revision:0},applyFields={},sameFields=[],conflicts=[];
  for(const [field,remoteValue] of Object.entries(op.changedFields)){
    const baseVersion=op.baseFieldVersions?.[field]||null,currentVersion=entity.fieldVersions?.[field]||null,currentValue=entity.values?.[field]??null;
    if(entity.resolvedFieldVersions?.[field]?.includes(op.opId)){sameFields.push(field);continue;}
    if(fieldValueEqual(currentValue,remoteValue)){sameFields.push(field);continue;}
    if(op.resolvesFieldVersions?.[field]?.includes(currentVersion)){applyFields[field]=remoteValue;continue;}
    if(currentVersion===baseVersion){applyFields[field]=remoteValue;continue;}
    conflicts.push({conflictId:`${op.opId}:${field}`,opId:op.opId,dbId:op.dbId,epoch:op.epoch,entityType:op.entityType,entityId:op.entityId,field,baseFieldVersion:baseVersion,localFieldVersion:currentVersion,localValue:currentValue,remoteValue,cabinetId:entity.values?.cabinetId||op.changedFields.cabinetId||'',description:entity.values?.description||entity.values?.point||op.changedFields.description||op.changedFields.point||'',createdAt:new Date().toISOString(),resolved:false});
  }
  return {duplicate:false,applyFields,sameFields,conflicts};
}
function commitSyncOperation(op,plan){
  if(plan.duplicate)return false;
  const entity=TC.sync.entities[op.entityType][op.entityId]||(TC.sync.entities[op.entityType][op.entityId]={key:'',fieldVersions:{},values:{},revision:0});
  for(const [field,value] of Object.entries(plan.applyFields)){entity.values[field]=value;entity.fieldVersions[field]=op.opId;}
  for(const field of plan.sameFields||[])if(op.resolvesFieldVersions?.[field])entity.fieldVersions[field]=op.opId;
  for(const [field,versions] of Object.entries(op.resolvesFieldVersions||{})){
    entity.resolvedFieldVersions??={};entity.resolvedFieldVersions[field]=[...new Set([...(entity.resolvedFieldVersions[field]||[]),...versions])];
    for(const conflict of TC.sync.conflicts)if(!conflict.resolved&&conflict.entityType===op.entityType&&conflict.entityId===op.entityId&&conflict.field===field&&versions.includes(conflict.opId)){conflict.resolved=true;conflict.resolution='peer';conflict.resolvedAt=op.createdAt||new Date().toISOString();}
  }
  for(const conflict of plan.conflicts)if(!TC.sync.conflicts.some(c=>c.conflictId===conflict.conflictId))TC.sync.conflicts.push(conflict);
  entity.revision=(Number(entity.revision)||0)+(Object.keys(plan.applyFields).length?1:0);
  if(!TC.sync.journal.some(x=>x.opId===op.opId))TC.sync.journal.push(cloneData(op));
  if(!TC.sync.appliedOps.includes(op.opId))TC.sync.appliedOps.push(op.opId);
  return true;
}
function syncFieldLabel(field){
  if(field.startsWith('score_'))return CHECKS.find(([col])=>col===field.slice(6))?.[1]||field;
  return ({cabinetId:'Elektrikilp',date:'Kuupäev',inspector:'Kontrollija',start:'Kontrolli algus',end:'Kontrolli lõpp',duration:'Kontrolli kestus',exception:'Erandi põhjus',point:'Kontrollpunkt',description:'Kirjeldus',priority:'Prioriteet',repeat:'Korduv',owner:'Vastutaja',due:'Tähtaeg',repairer:'Parandaja',closed:'Staatus',closedAt:'Paranduse aeg',repairAction:'Parandus',lastCheckedBy:'Viimati kontrollis',status:'Kasutuse staatus',note:'Märkus'})[field]||field;
}
function syncConflictBody(c){
  const local=c.localValue==null?'(tühi)':String(c.localValue),remote=c.remoteValue==null?'(tühi)':String(c.remoteValue);
  return `<b>${esc(c.cabinetId||c.entityId)}</b><br>${c.entityType==='Puudus'?`Puudus: ${esc(c.description||'kirjeldus puudub')}<br>`:''}<br><b>Väli:</b> ${esc(syncFieldLabel(c.field))}<div class="topgap"><b>SELLES TELEFONIS:</b><br>${esc(local)}</div><div class="topgap"><b>TEISES TELEFONIS:</b><br>${esc(remote)}</div>`;
}
async function promptSyncConflict(c){
  return showAppChoice('ANDMETE VASTUOLU',syncConflictBody(c),[{value:'local',label:'JÄTA SELLE TELEFONI VÄÄRTUS',primary:true},{value:'remote',label:'KASUTA TEISE TELEFONI VÄÄRTUST'}]);
}
function resolveSyncConflictMetadata(conflictId,choice){
  const c=TC.sync?.conflicts?.find(x=>x.conflictId===conflictId&&!x.resolved);if(!c||!['local','remote'].includes(choice))return false;
  c.resolution=choice;c.resolved=true;c.resolvedAt=new Date().toISOString();return true;
}
function nextSyncSequence(){
  const prior=Number(TC.sync.deviceSequences?.[TC.deviceId])||0,existing=Math.max(0,...TC.sync.journal.filter(op=>op.deviceId===TC.deviceId).map(op=>Number(op.localSequence)||0)),n=Math.max(prior,existing)+1;
  TC.sync.deviceSequences??={};TC.sync.deviceSequences[TC.deviceId]=n;TC.sync.sequence=Math.max(Number(TC.sync.sequence)||0,n);return n;
}
function appendConflictResolutionOperation(conflict,choice){
  const entity=TC.sync.entities[conflict.entityType][conflict.entityId],value=choice==='remote'?conflict.remoteValue:conflict.localValue,localSequence=nextSyncSequence(),opId=`${TC.deviceId}:${localSequence}`;
  const action=conflict.entityType==='Puudus'&&conflict.field==='closedAt'&&value?'CLOSE_PUUDUS':conflict.entityType==='Puudus'?'UPDATE_PUUDUS':conflict.entityType==='Kontroll'?'UPDATE_KONTROLL':'UPDATE_CABINET_STATUS';
  const resolves=[conflict.localFieldVersion,conflict.opId].filter(Boolean);
  const op={schema:1,opId,deviceId:TC.deviceId,localSequence,createdAt:new Date().toISOString(),dbId:TC.dbId,epoch:TC.sync.epoch,entityType:conflict.entityType,entityId:conflict.entityId,action,baseRevision:Number(entity.revision)||0,baseFieldVersions:{[conflict.field]:conflict.opId},resolvesFieldVersions:{[conflict.field]:resolves},changedFields:{[conflict.field]:value}};
  entity.values[conflict.field]=value;entity.fieldVersions[conflict.field]=opId;entity.revision=(Number(entity.revision)||0)+1;TC.sync.journal.push(op);if(!TC.sync.appliedOps.includes(opId))TC.sync.appliedOps.push(opId);return op;
}
async function resolvePendingSyncConflicts(){
  const pending=(TC.sync?.conflicts||[]).filter(c=>!c.resolved),decisions=[];
  for(const c of pending){const choice=await promptSyncConflict(c);if(!['local','remote'].includes(choice))throw Error('Vastuolu lahendamine katkestati. Telefoni senine töö jäi alles.');decisions.push({conflictId:c.conflictId,choice});}
  if(!decisions.length)return 0;
  const ok=await transaction(async()=>{
    for(const d of decisions){
      const c=TC.sync.conflicts.find(x=>x.conflictId===d.conflictId);if(!c)throw Error('Vastuolu kirje puudub. Sünkroonimist ei muudetud.');
      const entity=TC.sync.entities[c.entityType]?.[c.entityId];if(!entity)throw Error('Vastuolu kirje puudub. Sünkroonimist ei muudetud.');
      if(d.choice==='remote'){
        entity.fieldVersions[c.field]=c.opId;
        await applySyncOperationToWorkbook({entityType:c.entityType,entityId:c.entityId,action:'UPDATE_'+c.entityType.toUpperCase()}, {applyFields:{[c.field]:c.remoteValue}});
        entity.values[c.field]=c.remoteValue;
      }else{entity.fieldVersions[c.field]=c.opId;entity.values[c.field]=c.localValue;}
      appendConflictResolutionOperation(c,d.choice);
      resolveSyncConflictMetadata(c.conflictId,d.choice);
    }
    S.dirty=true;
  });
  if(!ok)throw Error('Vastuolude salvestamine ebaõnnestus. Telefoni eelmine töö jäi alles.');
  return decisions.length;
}
function writeSyncText(doc,col,row,value){if(value==null||value==='')clearInput(doc,col,row);else setInline(doc,col,row,String(value));}
function writeSyncDate(doc,col,row,value){
  if(value==null||value===''){clearInput(doc,col,row);return;}
  const s=String(value);if(/^\d{4}-\d{2}-\d{2}$/.test(s)){setDate(doc,col,row,s);return;}
  const n=Number(s);if(Number.isFinite(n)){setNum(doc,col,row,n);return;}
  const d=new Date(s);if(!Number.isNaN(d.getTime()))setDateTime(doc,col,row,d);else throw Error('Sünkroonitud kuupäev on vigane: '+col);
}
function rememberIncomingRow(type,entityId,row){
  TC.pendingSemanticRows??={Kontroll:{},Puudus:{}};TC.pendingSemanticRows[type]??={};TC.pendingSemanticRows[type][entityId]=row;
  TC.pendingSyncRowIds??={Kontroll:{},Puudus:{}};TC.pendingSyncRowIds[type]??={};TC.pendingSyncRowIds[type][String(row)]=entityId;
}
function findIncomingRow(type,entityId){
  const cached=TC.pendingSemanticRows?.[type]?.[entityId];if(cached)return cached;
  return type==='Kontroll'?TC.records.find(r=>r.syncId===entityId)?.row:TC.allDefects.find(d=>d.syncId===entityId)?.row;
}
async function writeIncomingControl(op,fields,values){
  const doc=await loadDoc('Kontrollid'),existingRow=findIncomingRow('Kontroll',op.entityId),row=existingRow||firstEmptyRow(doc,'B',5,Math.max(10000,...qsa(doc,'row').map(x=>Number(x.getAttribute('r'))))+1),styles=await ensureTimeStyles();
  const textFields={cabinetId:'B',area:'C',inspector:'D',panel:'E',device:'F',location:'G',exception:'Z'};
  for(const [field,col] of Object.entries(textFields))if(Object.hasOwn(fields,field)){
    if(['C','E','F','G'].includes(col)&&isFormulaCell(getCell(doc,col+row)))continue;
    writeSyncText(doc,col,row,fields[field]);
  }
  if(Object.hasOwn(fields,'date'))writeSyncDate(doc,'A',row,fields.date);
  for(const [col] of CHECKS){const field='score_'+col;if(!Object.hasOwn(fields,field))continue;const raw=fields[field];if(raw==null||raw==='')clearInput(doc,col,row);else if(Number.isFinite(Number(raw)))setNum(doc,col,row,Number(raw));else setInline(doc,col,row,String(raw));}
  if(Object.hasOwn(fields,'start')){writeSyncDate(doc,'W',row,fields.start);if(fields.start!=null&&fields.start!=='')ensureCell(doc,'W',row).setAttribute('s',styles.time);}
  if(Object.hasOwn(fields,'end')){writeSyncDate(doc,'X',row,fields.end);if(fields.end!=null&&fields.end!=='')ensureCell(doc,'X',row).setAttribute('s',styles.time);}
  if(Object.hasOwn(fields,'duration')){const v=fields.duration;if(v==null||v==='')clearInput(doc,'Y',row);else if(Number.isFinite(Number(v))){setNum(doc,'Y',row,Number(v));ensureCell(doc,'Y',row).setAttribute('s',styles.duration);}else throw Error('Sünkroonitud kontrolli kestus ei ole arvuline.');}
  S.zip.file(S.paths.Kontrollid,xmlStr(doc));rememberIncomingRow('Kontroll',op.entityId,row);
  const fp=recordFingerprint({id:values.cabinetId,date:values.date,inspector:values.inspector,start:getCellVal(doc,'W',row)});
  if(TC.cycle&&values.cycleId===TC.cycle.id){
    const old=TC.cycle.entries[values.cabinetId];
    if(!old||old.kontrollId===op.entityId||old.fingerprint===fp)TC.cycle.entries[values.cabinetId]={...(old||{}),row,fingerprint:fp,kontrollId:op.entityId,defectRows:old?.defectRows||[],note:values.note||old?.note||''};
    else{const extra=new Set(old.additionalKontrollIds||[]);extra.add(op.entityId);TC.cycle.entries[values.cabinetId]={...old,additionalKontrollIds:[...extra]};}
  }
}
async function writeIncomingDefect(op,fields,values){
  const doc=await loadDoc('Puudused'),existingRow=findIncomingRow('Puudus',op.entityId),row=existingRow||firstEmptyRow(doc,'B',5,Math.max(10000,...qsa(doc,'row').map(x=>Number(x.getAttribute('r'))))+1);
  const textFields={cabinetId:'B',inspector:'E',point:'F',description:'G',priority:'H',repeat:'I',owner:'J',repairer:'L',repairAction:'O',lastCheckedBy:'P'};
  for(const [field,col] of Object.entries(textFields))if(Object.hasOwn(fields,field))writeSyncText(doc,col,row,fields[field]);
  for(const [field,col] of [['cabinetTitle','C'],['location','D']])if(Object.hasOwn(fields,field)&&!isFormulaCell(getCell(doc,col+row)))writeSyncText(doc,col,row,fields[field]);
  if(Object.hasOwn(fields,'date'))writeSyncDate(doc,'A',row,fields.date);
  if(Object.hasOwn(fields,'due'))writeSyncDate(doc,'K',row,fields.due);
  if(Object.hasOwn(fields,'closedAt')){const styles=await ensureTimeStyles();writeSyncDate(doc,'M',row,fields.closedAt);if(fields.closedAt!=null&&fields.closedAt!=='')ensureCell(doc,'M',row).setAttribute('s',styles.time);}
  S.zip.file(S.paths.Puudused,xmlStr(doc));rememberIncomingRow('Puudus',op.entityId,row);
  const cycle=TC.cycle,link=cycle?.entries?.[values.cabinetId];if(cycle&&values.cycleId===cycle.id&&link){if(!values.kontrollId||!link.kontrollId||link.kontrollId===values.kontrollId)link.defectRows=[...new Set([...(link.defectRows||[]),row])];else{link.previousControlDefects??={};link.previousControlDefects[values.kontrollId]=[...new Set([...(link.previousControlDefects[values.kontrollId]||[]),row])];}}
}
async function applySyncOperationToWorkbook(op,plan){
  const fields=plan.applyFields;if(!Object.keys(fields).length)return;
  const entity=TC.sync.entities[op.entityType]?.[op.entityId],values={...(entity?.values||{}),...fields};
  if(op.entityType==='Kontroll'){await writeIncomingControl(op,fields,values);return;}
  if(op.entityType==='Puudus'){await writeIncomingDefect(op,fields,values);return;}
  if(op.entityType==='Cabinet'){
    const cabinet=S.cabinets.find(c=>c.id===(fields.cabinetId||values.cabinetId));if(!cabinet)throw Error('Sünkroonitud kilpi ei leitud registrist: '+(fields.cabinetId||values.cabinetId||op.entityId));
    if(Object.hasOwn(fields,'status')){const doc=await loadDoc('Kokkuvõte');setInline(doc,'H',cabinet.row,String(fields.status||''));S.zip.file(S.paths['Kokkuvõte'],xmlStr(doc));}
    return;
  }
  throw Error('Sünkroonitud kirjeliik ei ole toetatud.');
}
async function applySyncOperations(operations,senderDeviceId=''){
  if(!Array.isArray(operations))throw Error('Sünkroonimispaketis puudub muudatuste loend.');
  const report={applied:0,duplicates:0,conflicts:0};
  const ok=await transaction(async()=>{
    TC.pendingSemanticRows={Kontroll:{},Puudus:{}};
    for(const op of operations){
      const plan=planSyncOperation(op);if(plan.duplicate){report.duplicates++;continue;}
      await applySyncOperationToWorkbook(op,plan);commitSyncOperation(op,plan);report.applied++;report.conflicts+=plan.conflicts.length;
    }
    if(senderDeviceId&&senderDeviceId!==TC.deviceId){
      const localIds=new Set(TC.sync.journal.filter(op=>op.deviceId===TC.deviceId).map(op=>op.opId)),acknowledged=operations.filter(op=>localIds.has(op.opId)).map(op=>op.opId);
      TC.sync.peerAcks??={};TC.sync.peerAcks[senderDeviceId]=[...new Set([...(TC.sync.peerAcks[senderDeviceId]||[]),...acknowledged])];
    }
    S.dirty=true;
   },{skipSemanticJournal:true});
  TC.pendingSemanticRows=null;if(!ok)throw Error('Sünkroonimist ei salvestatud. Tööfail ja muudatuste ajalugu taastati.');
  return report;
}
async function persistWorkspace(){
  if(!TC.dbId||!S.zip)throw Error('Tööfail ei ole avatud');
  await ensureSyncState();TC.revision++;TC.updatedAt=new Date().toISOString();await writeMetadata();await forceRecalc();
  const bytes=await S.zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
  TC.localUsedAt=new Date().toISOString();
  const snapshot={schema:1,dbId:TC.dbId,fileName:S.fileName,registryKey:TC.registryKey,registryTokens:TC.registryTokens,cycle:TC.cycle,sync:TC.sync,guard:TC.guard,revision:TC.revision,updatedAt:TC.updatedAt,lastUsedAt:TC.localUsedAt,sourceHash:TC.sourceHash,baseWorkbookBase64:TC.baseWorkbookBase64,inspector:S.inspector,dirty:S.dirty,workbookHash:await digest(bytes),summary:captureWorkspaceSummary({updatedAt:TC.updatedAt,revision:TC.revision}),workbookBase64:bytesToBase64(bytes)};
  await storeCall('put',snapshot);TC.startupLoaded=true;TC.startupSnapshot=snapshot;return bytes;
}
async function transaction(change,options={}){
  if(TC.busy||TC.exportPending)return false;setBusy(true);
  const rowIds={Kontroll:Object.fromEntries(TC.records.map(r=>[String(r.row),r.syncId]).filter(([,id])=>id)),Puudus:Object.fromEntries(TC.allDefects.map(d=>[String(d.row),d.syncId]).filter(([,id])=>id))};
  const before={zip:cloneWorkbook(S.zip),tc:cloneData({cycle:TC.cycle,guard:TC.guard,revision:TC.revision,updatedAt:TC.updatedAt,sync:TC.sync}),semantic:semanticState(),inspector:S.inspector,dirty:S.dirty};
  let committed=false;
  try{TC.pendingSyncRowIds=rowIds;await change();await refreshFromWorkbook();if(!options.skipSemanticJournal)await appendSemanticOperations(before.semantic);await persistWorkspace();committed=true;renderCyclePanel();return true;}
  catch(e){if(committed){alert('Andmed on telefonis salvestatud, kuid vaadet ei saanud uuendada. Ava tööfail uuesti.\n'+e.message);return true;}S.zip=before.zip;Object.assign(TC,before.tc);TC.pendingSyncRowIds=null;TC.pendingSemanticRows=null;S.inspector=before.inspector;S.dirty=before.dirty;await refreshFromWorkbook();alert('Andmeid EI salvestatud. Proovi uuesti.\n'+e.message);return false;}
  finally{TC.pendingSyncRowIds=null;TC.pendingSemanticRows=null;setBusy(false);}
}
function saveRingProgress(){/* Called only for explicit inspector changes, never from rendering. */if(TC.dbId&&!TC.busy)transaction(async()=>{});}
function restoreRingProgress(){reconcileCycle();}
async function loadBook(bytes,name){S.zip=await JSZip.loadAsync(bytes,{checkCRC32:true});S.fileName=name;await loadSharedStrings();await loadSheetPaths();for(const n of ['Kokkuvõte','Kontrollid','Puudused'])if(!S.paths[n]||!S.zip.file(S.paths[n]))throw Error('Leht puudub: '+n);await refreshFromWorkbook();}
async function mergeLocalIntoIncoming(local,incoming){
  if(!local.baseWorkbookBase64)throw Error('Varasema töö baaskoopia puudub');
  const base=await JSZip.loadAsync(decode64(local.baseWorkbookBase64)),ours=await JSZip.loadAsync(decode64(local.workbookBase64));
  const merged=cloneWorkbook(incoming),skip=new Set(['docProps/custom.xml','[Content_Types].xml','_rels/.rels','xl/workbook.xml']);
  async function namedPaths(zip){const wb=parseXml(await zip.file('xl/workbook.xml').async('string')),rels=parseXml(await zip.file('xl/_rels/workbook.xml.rels').async('string')),targets=Object.fromEntries(qsa(rels,'Relationship').map(x=>[x.getAttribute('Id'),normPath(x.getAttribute('Target'))]));return Object.fromEntries(qsa(wb,'sheet').map(x=>[x.getAttribute('name'),targets[localAttr(x,'id')]]));}
  const oursPaths=await namedPaths(ours),basePaths=await namedPaths(base),incomingPaths=await namedPaths(incoming),sheetNames=Object.fromEntries(Object.entries(oursPaths).map(([k,v])=>[v,k]));
  // Reopening an older original must never remove rows already present in saved work,
  // including rows that had previously been exported. Accept only an unambiguous subset.
  let incomingOlder=false;
  for(const sheetName of ['Kontrollid','Puudused']){
    const ownDoc=parseXml(await ours.file(oursPaths[sheetName]).async('string')),otherDoc=parseXml(await incoming.file(incomingPaths[sheetName]).async('string'));
    const ownRows=qsa(ownDoc,'row').filter(r=>Number(r.getAttribute('r'))>=5&&getCellVal(ownDoc,'B',Number(r.getAttribute('r'))));
    const otherRows=qsa(otherDoc,'row').filter(r=>Number(r.getAttribute('r'))>=5&&getCellVal(otherDoc,'B',Number(r.getAttribute('r'))));
    if(ownRows.length>otherRows.length){
      for(const re of otherRows){const row=Number(re.getAttribute('r'));for(const col of sheetName==='Kontrollid'?['A','B','D','H','I','J','K','L','M','N','O','P','Q','R','W','X','Y','Z']:['A','B','E','F','G','H','I','J','K','L','M','O','P']){
        const a=getCellVal(ownDoc,col,row),b=getCellVal(otherDoc,col,row);if(a!==b&&!(a!==''&&b!==''&&Number.isFinite(Number(a))&&Number(a)===Number(b)))throw Error('Vanema koopia kirje erineb: '+sheetName+'!'+col+row);
      }}incomingOlder=true;
    }
  }
  for(const [name,entry] of Object.entries(ours.files)){
    if(entry.dir||skip.has(name))continue;
    const sheetName=sheetNames[name],basePath=sheetName?basePaths[sheetName]:name,targetPath=sheetName?incomingPaths[sheetName]:name;
    const old=basePath&&base.file(basePath)?await base.file(basePath).async('string'):null,own=await entry.async('string');
    if(incomingOlder&&(sheetName==='Kontrollid'||sheetName==='Puudused'||sheetName==='Kokkuvõte'||name==='xl/styles.xml')){if(!targetPath)throw Error('Leht puudub: '+sheetName);merged.file(targetPath,await entry.async('uint8array'));continue;}
    if(own===old)continue;
    if(!targetPath)throw Error('Valitud failis puudub muudetud leht '+sheetName);
    const other=incoming.file(targetPath)?await incoming.file(targetPath).async('string'):null;
    if(other===own)continue;if(other===old){merged.file(targetPath,await entry.async('uint8array'));continue;}
    if(!/^xl\/worksheets\/[^/]+\.xml$/.test(name)||!old||!other)throw Error('Mõlemad koopiad muutsid osa '+name);
    const a=parseXml(old),b=parseXml(own),c=parseXml(other);const am=cellMap(a),bm=cellMap(b),cm=cellMap(c);
    const value=node=>node?xmlStr(node):'';
    for(const ref of new Set([...am.keys(),...bm.keys()])){
      const av=value(am.get(ref)),bv=value(bm.get(ref)),cv=value(cm.get(ref));if(av===bv||bv===cv)continue;
      if(cv!==av)throw Error('Mõlemad koopiad muutsid lahtrit '+name+'!'+ref);
      const current=cm.get(ref),replacement=bm.get(ref);if(current)current.parentNode.removeChild(current);
      if(replacement){const row=Number(ref.match(/\d+$/)[0]),parent=rowEl(c,row),copy=c.importNode(replacement,true);const next=qsa(parent,'c').find(x=>colNum(refCol(x.getAttribute('r')))>colNum(refCol(ref)));if(next)parent.insertBefore(copy,next);else parent.appendChild(copy);cm.set(ref,copy);}else cm.delete(ref);
    }
    merged.file(targetPath,xmlStr(c));
  }
  return merged;
}
async function importXlsx(ev){
  if(TC.startupTask)await TC.startupTask;
  const file=ev.target.files?.[0];if(!file||TC.busy)return;
  const old={zip:S.zip,fileName:S.fileName,tc:cloneData({...TC,opened:null,pending:null}),inspector:S.inspector,dirty:S.dirty};
  setBusy(true);stopInspectionTimer();
  try{
    const bytes=new Uint8Array(await file.arrayBuffer());TC.cycle=null;TC.ready=false;await loadBook(bytes,file.name);
    const identity=await registryIdentity(),embedded=await readMetadata(),all=await storeCall('list');
    if(embedded?.cycle){TC.cycle=embedded.cycle;await refreshFromWorkbook();}
    const incomingSummary=captureWorkspaceSummary({updatedAt:embedded?.updatedAt,revision:embedded?.revision});
    let candidates=all.filter(x=>embedded?.dbId?x.dbId===embedded.dbId:x.registryKey===identity.key);
    if(!candidates.length&&!embedded?.dbId&&identity.tokens.length){const set=new Set(identity.tokens);candidates=all.filter(x=>{const t=x.registryTokens||[];const same=t.filter(v=>set.has(v)).length;return same/Math.max(t.length,set.size)>=0.9;});}
    if(candidates.length>1)throw Error('Sellele tabelile vastab mitu salvestatud andmebaasi. Ava viimati eksporditud XLSX, millel on andmebaasi tunnus.');
    let local=candidates[0]?await storeCall('get',candidates[0].dbId):null;
    if(local){
      try{const saved=decode64(local.workbookBase64||'');if(!saved.length)throw Error('Telefonis puudub salvestatud XLSX.');if(local.workbookHash&&await digest(saved)!==local.workbookHash)throw Error('Telefonis oleva XLSX kontrollsumma ei klapi.');await JSZip.loadAsync(saved,{checkCRC32:true});}
      catch(e){const recovery=await showAppChoice('Telefonis olev tööfail on vigane',`Salvestatud tööfaili ei saanud kontrollida.<br>${esc(e.message)}<br><br>Vali uus XLSX ainult siis, kui oled valmis katkise telefoni koopia asemel seda jätkama.`,[{value:'replace',label:'AVA VALITUD XLSX',primary:true},{value:'cancel',label:'TÜHISTA'}]);if(recovery!=='replace')throw Error('Valitud XLSX jäi avamata. Telefoni tööfaili ei muudetud.');local=null;}
    }
    let chosenBytes=bytes,chosenName=file.name,merged=false,selectedInternal=false,notice='Valitud XLSX avati. Telefon salvestab edasised muudatused automaatselt.';
    if(local){
      let localSummary=local.summary;
      if(!localSummary){
        TC.cycle=local.cycle||null;await loadBook(decode64(local.workbookBase64),local.fileName||file.name);localSummary=captureWorkspaceSummary({updatedAt:local.updatedAt,revision:local.revision});
        TC.cycle=embedded?.cycle||null;await loadBook(bytes,file.name);if(embedded?.cycle)await refreshFromWorkbook();
      }
      const externalIsOriginal=!!(local.sourceHash&&await digest(bytes)===local.sourceHash);
      const choice=await showWorkspaceComparison(local,embedded,localSummary,incomingSummary,externalIsOriginal);
      if(choice==='cancel'||!choice)throw Error('Faili valik tühistati. Telefonis salvestatud töö jäi alles.');
      if(choice==='internal'){
        selectedInternal=true;chosenBytes=decode64(local.workbookBase64);chosenName=local.fileName||file.name;
        Object.assign(TC,{dbId:local.dbId,registryKey:local.registryKey||identity.key,registryTokens:local.registryTokens||identity.tokens,cycle:local.cycle||null,sync:local.sync||null,guard:local.guard||{remaining:randomGap(),pending:null},revision:Number(local.revision)||0,updatedAt:local.updatedAt||null,sourceHash:local.sourceHash||'',baseWorkbookBase64:local.baseWorkbookBase64||''});
        S.inspector=local.inspector||'';S.dirty=!!local.dirty;notice='Jätkatakse telefonis salvestatud tööfailiga. Valitud välist faili ei muudetud.';
      }else{
        let importedZip=S.zip,cycle=embedded?.cycle||null;
        if(choice==='merge'){
          try{importedZip=await mergeLocalIntoIncoming(local,S.zip);merged=true;notice='Tööfailid ühendati. Telefonis olnud muudatused säilitati ja algfaili ei muudetud.';}
          catch(e){
            const recovery=await showAppChoice('Turvalist ühendamist ei saanud teha',`Telefonis olev töö ei ole muutunud.<br>${esc(e.message)}<br><br>Vali, kas jätkata telefonis salvestatud tööga või teadlikult kasutada valitud faili.`,[{value:'internal',label:'JÄTKA TELEFONI TÖÖGA',primary:true},{value:'replace',label:'KASUTA VALITUD FAILI JA ASENDA TELEFONI KOOPIA'},{value:'cancel',label:'TÜHISTA'}]);
            if(recovery==='cancel'||!recovery)throw Error('Ühendamine tühistati. Telefonis salvestatud töö jäi alles.');
            if(recovery==='internal'){selectedInternal=true;chosenBytes=decode64(local.workbookBase64);chosenName=local.fileName||file.name;Object.assign(TC,{dbId:local.dbId,registryKey:local.registryKey||identity.key,registryTokens:local.registryTokens||identity.tokens,cycle:local.cycle||null,sync:local.sync||null,guard:local.guard||{remaining:randomGap(),pending:null},revision:Number(local.revision)||0,updatedAt:local.updatedAt||null,sourceHash:local.sourceHash||'',baseWorkbookBase64:local.baseWorkbookBase64||''});S.inspector=local.inspector||'';S.dirty=!!local.dirty;notice='Telefonis salvestatud töö taastati; ühendamine ebaõnnestus.';}
            else{cycle=embedded?.cycle||null;notice='Valitud fail kasutati sinu kinnitusega; telefoni eelmist koopiat ei kirjutatud tagasi.';}
          }
        }
        if(!selectedInternal){
          const mergedCycle=merged&&local.cycle&&cycle&&local.cycle.id===cycle.id?{...local.cycle,...cycle,entries:{...(local.cycle.entries||{}),...(cycle.entries||{})}}:(merged&&local.cycle&&!cycle?local.cycle:cycle);
          chosenBytes=await importedZip.generateAsync({type:'uint8array'});chosenName=file.name;
          Object.assign(TC,{dbId:embedded?.dbId||local.dbId,registryKey:identity.key,registryTokens:identity.tokens,cycle:mergedCycle,sync:local.sync||embedded?.sync||null,guard:local.guard||{remaining:randomGap(),pending:null},revision:Math.max(Number(local.revision)||0,Number(embedded?.revision)||0),updatedAt:embedded?.updatedAt||local.updatedAt||null,sourceHash:await digest(bytes),baseWorkbookBase64:bytesToBase64(bytes)});
          S.inspector=embedded?.inspector||local.inspector||'';S.dirty=merged||!!local.dirty;
        }
      }
    }else{
      Object.assign(TC,{dbId:embedded?.dbId||uid(),registryKey:identity.key,registryTokens:identity.tokens,cycle:embedded?.cycle||null,sync:embedded?.sync||null,guard:{remaining:randomGap(),pending:null},revision:embedded?.revision||0,updatedAt:embedded?.updatedAt||null,sourceHash:await digest(bytes),baseWorkbookBase64:bytesToBase64(bytes)});S.inspector=embedded?.inspector||'';S.dirty=false;
      if(!TC.cycle){let legacy;try{legacy=JSON.parse(localStorage.getItem(RING_STORAGE_KEY)||'null');}catch(e){}
        if(legacy?.startedAt&&legacy.checked?.length){const start=localDateIso(new Date(legacy.startedAt));const records=TC.records.filter(r=>legacy.checked.includes(r.id)&&r.date>=start);if(records.length){TC.cycle=cycleFromRecords(records,legacy.startedAt);S.inspector=legacy.inspector||S.inspector;}}
      }
    }
    TC.ready=false;TC.opened=null;S.stagedDefects=[];
    await loadBook(chosenBytes,chosenName);await refreshFromWorkbook();
    TC.pending={notice};TC.startupLoaded=true;TC.startupError='';TC.startupWarning='';TC.activated=true;await persistWorkspace();
    $('workTabs').classList.remove('hidden');$('exportBtn').disabled=false;$('shareXlsxBtn').disabled=false;$('sharePackageBtn').disabled=false;$('workbookImportCard').classList.add('hidden');loadMinInspectionSetting();renderStartupWorkspace();renderCyclePanel();showTab('home');
    toast(notice,4000);
  }catch(e){S.zip=old.zip;S.fileName=old.fileName;Object.assign(TC,old.tc);S.inspector=old.inspector;S.dirty=old.dirty;if(S.zip){await loadSharedStrings();await loadSheetPaths();await refreshFromWorkbook();}renderStartupWorkspace();alert('XLSX avamine ebaõnnestus. Salvestatud töö jäi alles.\n'+e.message);}
  finally{setBusy(false);ev.target.value='';}
}
function cycleFromRecords(records,startedAt){
  const cycle={id:uid(),startedAt:cycleStartFromRecords(records,startedAt),startSource:'records',entries:{}};
  for(const r of records.sort((a,b)=>a.date.localeCompare(b.date)||a.row-b.row))cycle.entries[r.id]={row:r.row,fingerprint:recordFingerprint(r),defectRows:TC.allDefects.filter(d=>d.id===r.id&&d.date===r.date&&d.inspector===r.inspector).map(d=>d.row),note:''};return cycle;
}
function renderCyclePanel(){
  const box=$('cyclePanel');if(!box)return;
  const active=activeCabinets(),checked=active.filter(c=>S.sessionChecked.has(c.id)).length;
  $('fileState').classList.remove('hidden');
  $('shareXlsxBtn').disabled=!S.zip||!TC.dbId;
  $('sharePackageBtn').disabled=!S.zip||!TC.dbId;
  renderSyncStatus();
  $('fileState').innerHTML=`<b>${esc(S.fileName)}</b><br>${S.cabinets.length} objekti • aktiivses kontrollis ${active.length} • avatud puudusi ${S.existingDefects.length}<br>${S.dirty?'Muudatused on telefonis salvestatud; väline koopia on uuendamata.':'Tööfail on telefonis salvestatud.'}`;
  renderStartupWorkspace();
  if(TC.cycle){box.innerHTML=`<div class="big">${checked===active.length?'Kontroll läbitud':'Pooleliolev kontroll'}</div><p>${checked} / ${active.length}<br>Alustatud: ${esc(cycleStartLabel(TC.cycle))}</p>${TC.pending?.notice?`<p class="small">${esc(TC.pending.notice)}</p>`:''}<button class="primary" onclick="continueCycle()">JÄTKA KONTROLLI</button><button onclick="resetRingProgress()">UUS KONTROLL</button>`;}
  else{const dates=TC.records.map(r=>r.date).filter(Boolean).sort();box.innerHTML=`<div class="big">Kontrolli alustamine</div><button class="primary" onclick="resetRingProgress()">ALUSTA UUT KONTROLLI</button>${dates.length?`<details><summary>Jätka varasema versiooniga tehtud kontrolli</summary><p class="small">Vali selle läbimise tegelik alguskuupäev. Seotakse ainult selle kuupäeva ja hilisemad Kontrollid kirjed.</p><input type="date" id="legacyCycleDate" value="${esc(dates[dates.length-1])}"><button onclick="adoptHistoryCycle()">JÄTKA TABELI KONTROLLI</button></details>`:''}`;}
}
function localPendingSyncCount(){
  const acknowledged=new Set(Object.values(TC.sync?.peerAcks||{}).flat());
  return (TC.sync?.journal||[]).filter(op=>op.deviceId===TC.deviceId&&!acknowledged.has(op.opId)).length;
}
function renderSyncStatus(){
  const ready=!!(S.zip&&TC.dbId&&TC.sync),baseline=$('syncBaselineBtn'),send=$('syncSendBtn'),receive=$('syncReceiveBtn'),status=$('syncLocalStatus');
  if(baseline)baseline.disabled=!ready;if(send)send.disabled=!ready||!(TC.sync?.journal||[]).length;if(receive)receive.disabled=!ready;
  if(status)status.textContent=ready?`Saatmata muudatusi selles telefonis: ${localPendingSyncCount()} • Lahendamata vastuolusid: ${(TC.sync.conflicts||[]).filter(c=>!c.resolved).length}`:'Ava esmalt XLSX tööfail.';
}
function continueCycle(){if(TC.busy)return;TC.ready=true;TC.pending=null;showTab('cab');}
async function resetRingProgress(){
  if(TC.busy||!S.zip)return;if(TC.cycle&&!confirm('Alustada uut kontrolli? Praeguse kontrolli progress nullitakse. Kõik salvestatud kontrollid ja puudused jäävad alles.'))return;
  if(await transaction(async()=>{TC.cycle={id:uid(),startedAt:localCycleStamp(),startSource:'manual',entries:{}};S.dirty=true;})){TC.ready=true;showTab('cab');toast('Uus kontroll alustatud');}
}
async function adoptHistoryCycle(){
  const date=$('legacyCycleDate').value;if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return;
  const records=TC.records.filter(r=>r.date>=date),ids=new Set(records.map(r=>r.id));if(!records.length){toast('Valitud ajavahemikus kirjeid ei ole');return;}
  const n=ids.size,choice=await showAppChoice('Jätka tabeli kontrolli',`Leiti tabelist <b>${n} kilbi</b> kontrollitud kilbid alates <b>${esc(date)}</b>.<br><br>Kas soovid need lisada praeguse kontrolli jätkuks? Pärast kinnitamist kuvatakse need kontrollitutena ja loendur muutub ${n} / ${activeCabinets().length}.`,[{value:'continue',label:`JÄTKA ${n} KONTROLLIGA`,primary:true},{value:'cancel',label:'TÜHISTA'}]);
  if(choice!=='continue')return;
  if(await transaction(async()=>{TC.cycle=cycleFromRecords(records);S.dirty=true;})){TC.ready=true;showTab('cab');}
}
async function openWorkMode(mode){const person=($('homePerson').value||'').trim();if(person&&person!==S.inspector){S.inspector=person;await transaction(async()=>{});}if(mode==='repair'){S.defectObjectFilter='';showTab('def');return;}if(TC.cycle)continueCycle();else{showTab('home');renderCyclePanel();toast('Alusta kõigepealt kontrolli');}}
function renderAreaStats(){const area=$('areaFilter').value,rows=activeCabinets().filter(c=>!area||c.area===area),done=rows.filter(c=>S.sessionChecked.has(c.id)).length;const box=$('areaStats');if(box)box.textContent=`${area||'Kõik alad'} • Kokku: ${rows.length} • Kontrollitud: ${done} • Kontrollimata: ${rows.length-done}`;}
function getMinInspectionSeconds(){let n=60;try{n=Number(localStorage.getItem(MIN_TIME_STORAGE_KEY)||60);}catch(e){}return Number.isFinite(n)?Math.max(60,Math.ceil(n)):60;}
function saveMinInspectionSetting(){const v=Number($('minInspectionSeconds').value),n=Number.isFinite(v)?Math.max(60,Math.ceil(v)):60;localStorage.setItem(MIN_TIME_STORAGE_KEY,String(n));$('minInspectionSeconds').value=String(n);if(TC.opened)tickInspection();}
function loadMinInspectionSetting(){const n=getMinInspectionSeconds();localStorage.setItem(MIN_TIME_STORAGE_KEY,String(n));if($('minInspectionSeconds'))$('minInspectionSeconds').value=String(n);}
function applyTheme(){const choice=localStorage.getItem('dold_theme')||'system',dark=choice==='dark'||choice==='system'&&matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=dark?'dark':'light';if($('themeSetting'))$('themeSetting').value=choice;if(window.Android&&typeof Android.setTheme==='function')Android.setTheme(dark);}
function saveThemeSetting(){localStorage.setItem('dold_theme',$('themeSetting').value);applyTheme();}
function monotonicNow(){return window.Android&&typeof Android.elapsedRealtime==='function'?Number(Android.elapsedRealtime()):performance.now();}
function elapsedSeconds(){return TC.opened?Math.max(0,(monotonicNow()-TC.opened.mono)/1000):0;}
function inspectionSeconds(){return (TC.opened?.previousSeconds||0)+elapsedSeconds();}
function tickInspection(){if(!TC.opened)return;const sec=Math.floor(inspectionSeconds()),h=Math.floor(sec/3600),m=Math.floor(sec%3600/60);$('inspectionTimer').textContent=(h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');const remaining=Math.max(0,Math.ceil(getMinInspectionSeconds()-inspectionSeconds()));$('minimumFeedback').textContent=remaining?`Kontrolli minimaalne aeg: veel ${remaining} s`:'Minimaalne kontrolliaeg täidetud';for(const b of document.querySelectorAll('#inspectTab .stickySave button'))b.disabled=remaining>0||TC.busy;}
function startInspectionTimer(){stopInspectionTimer();tickInspection();S.inspectTimerHandle=setInterval(tickInspection,250);}
function inspectionStamp(r){const time=excelClock(r?.start);return `${r?.date||'—'}${time?' '+time:''}`;}
async function viewSavedInspection(id,record,entry){
  const ratings=CHECKS.map(([col,label])=>`${esc(label)}: <b>${esc(record.ratings?.[col]||'—')}</b>`).join('<br>');
  const linkedRows=new Set(entry?.defectRows||[]),defects=TC.allDefects.filter(d=>d.id===id&&(linkedRows.has(d.row)||TC.sync?.entities?.Puudus?.[d.syncId]?.values?.kontrollId===record.syncId));
  const defectHtml=defects.length?defects.map(d=>`• ${esc(d.point||'Puudus')}: ${esc(d.desc||'')} — ${esc(d.closed?'Kõrvaldatud':'Avatud')}`).join('<br>'):'Puuduseid pole seotud';
  await showAppChoice('VAATA KONTROLLI',`<b>${esc(id)} • ${esc(cabinetTitle(S.selected))}</b><br>Kontrollitud: ${esc(inspectionStamp(record))}<br>Kontrollija: ${esc(record.inspector||'—')}<div class="topgap">${ratings}</div><div class="topgap"><b>Puudused (${defects.length})</b><br>${defectHtml}</div>`,[{value:'back',label:'TAGASI',primary:true}]);
}
async function openCab(id,source='list',duplicateAction='prompt'){
  if(TC.busy)return;if(!TC.ready||!TC.cycle){showTab('home');renderCyclePanel();toast('Vali JÄTKA KONTROLLI või alusta uut kontrolli');return;}
  const cabinet=S.cabinets.find(c=>c.id===id);if(!cabinet)return;S.selected=cabinet;
  const areaFilter=$('areaFilter');if(areaFilter){areaFilter.value=S.selected.area||'';renderCabinets();}
  const entry=TC.cycle.entries[id],current=savedEntry(id);
  if(current&&duplicateAction==='prompt'){
    const linkedRows=new Set(entry?.defectRows||[]),defectCount=TC.allDefects.filter(d=>d.id===id&&(linkedRows.has(d.row)||TC.sync?.entities?.Puudus?.[d.syncId]?.values?.kontrollId===current.syncId)).length;
    const choice=await showAppChoice(`${id} ON JUBA KONTROLLITUD`,`Kontrollitud: <b>${esc(inspectionStamp(current))}</b><br>Kontrollija: <b>${esc(current.inspector||'—')}</b><br>Puudused: <b>${defectCount}</b>`,[{value:'view',label:'VAATA KONTROLLI'},{value:'edit',label:'MUUDA KONTROLLI',primary:true},{value:'new',label:'UUS KONTROLL'},{value:'cancel',label:'TÜHISTA'}]);
    if(choice==='view'){await viewSavedInspection(id,current,entry);return;}
    if(choice==='edit')return openCab(id,source,'edit');
    if(choice==='new'){
      const confirmNew=await showAppChoice('LISA UUS KONTROLL',`See kilp on juba selles kontrolliringis kontrollitud.<br><br>Kas soovid tõesti luua uue eraldi kontrolli? See kilp jääb kontrolliringi loenduris ühe kontrollitud kilbina.`,[{value:'create',label:'LOO UUS KONTROLL',primary:true},{value:'cancel',label:'TÜHISTA'}]);
      if(confirmNew==='create')return openCab(id,source,'new');return;
    }
    return;
  }
  stopInspectionTimer();const forceNew=duplicateAction==='new',existing=forceNew?null:current;S.editInspectionRow=existing?.row||null;
  S.ratings=Object.fromEntries(CHECKS.map(([col])=>[col,/^[0-5]$/.test(String(existing?.ratings[col]??''))?String(existing.ratings[col]):'']));
  S.stagedDefects=existing?TC.allDefects.filter(d=>entry.defectRows?.includes(d.row)&&!d.closed&&d.id===id).map(d=>({...d,existingRow:d.row})):[];
  TC.opened={id,source,proved:source==='camera',startedAt:new Date().toISOString(),mono:monotonicNow(),previousSeconds:Math.max(0,(existing?.duration||0)*86400),existing,forceNew};
  S.inspectStartedAt=new Date(TC.opened.startedAt);$('defectEditor').innerHTML='';TC.editDefectIndex=null;
  $('inspectTitle').innerHTML=`<div class="big">${esc(id)} • ${esc(cabinetTitle(S.selected))}</div><div class="small">${esc(S.selected.panel)} • ${esc(S.selected.location)}<br>${esc(S.selected.area)} • ${esc(S.selected.status)}</div>${existing?'<div class="badge warn topgap">MUUDA KONTROLLI</div>':''}${!isActiveCabinet(S.selected)?'<div class="badge warn">Ei kuulu aktiivsesse kontrolli</div>':''}`;
  $('inspectionDate').value=existing?.date||localDateIso();$('inspector').value=existing?.inspector||S.inspector||S.selected.lastInspector||'';$('inspectorQuick').value=S.people.includes($('inspector').value)?$('inspector').value:'';
  $('cabStatus').innerHTML=statusOptions(S.selected.status);$('inspectComment').value=entry?.note||'';renderRatings();renderStagedDefects();
  for(const name of ['home','cab','def','data','repair','settings'])$(name+'Tab').classList.add('hidden');$('inspectTab').classList.remove('hidden');
  const buttons=document.querySelectorAll('#inspectTab .stickySave button');buttons[0].textContent=existing?'SALVESTA MUUDATUSED':'SALVESTA';buttons[1].textContent=existing?'SALVESTA MUUDATUSED + JÄRGMINE':'SALVESTA + JÄRGMINE';
  renderPresence();startInspectionTimer();window.scrollTo(0,0);
}
function randomGap(){const a=new Uint32Array(1);crypto.getRandomValues(a);return 4+a[0]%24;}
function renderPresence(){const el=$('presenceFeedback');if(!el)return;const required=TC.guard?.pending===S.selected?.id&&!TC.opened?.proved;el.innerHTML=required?`<div class="badge warn">Kohaloleku kinnitamiseks skaneeri ${esc(S.selected.id)} QR</div><br><button onclick="startPresenceScan()">SKANEERI SELLE KILBI QR</button>`:'';}
function startPresenceScan(){if(!TC.opened)return;S.qrMode='presence';if(window.Android&&typeof Android.scanQr==='function')Android.scanQr();else toast('Kohaloleku kontroll vajab Androidi kaameraskannerit',4000);}
async function ensurePresence(){
  if(TC.opened.proved)return true;
  if(TC.guard.pending||TC.guard.remaining<=1){
    if(TC.guard.pending!==S.selected.id){const ok=await transaction(async()=>{TC.guard.pending=S.selected.id;});if(!ok)return false;}
    renderPresence();startPresenceScan();return false;
  }
  return true;
}
function onNativeQrResult(raw){
  const id=normalizeQrId(raw);const proved=!!(id&&window.Android&&typeof Android.consumeQrProof==='function'&&Android.consumeQrProof(id));
  if(S.qrMode==='presence'){
    if(!TC.opened||id!==TC.opened.id||!proved){toast('Vale QR. Skaneeri '+(TC.opened?.id||'valitud kilbi')+' QR.',5000);renderPresence();return;}
    TC.opened.proved=true;renderPresence();toast('Kohalolek kinnitatud. Võid kontrolli salvestada.');return;
  }
  openQrId(raw,proved?'camera':'list');
}
function openQrId(raw,source='list'){
  const id=normalizeQrId(raw),cab=S.cabinets.find(c=>c.id===id);if(!cab){toast(id?id+' ei ole tabelis':'QR kood ei ole EK-xxx');return false;}
  if(S.qrMode==='presence'){toast('Kasuta kohaloleku kinnitamiseks kaameraskannerit');return false;}
  stopQrScanner();if(S.qrMode==='repair'){S.defectObjectFilter=id;showTab('def');renderDefects();}else openCab(id,source);return true;
}
function renderStagedDefects(){
  $('stagedDefects').innerHTML=S.stagedDefects.map((d,i)=>`<div class="miniDef"><div class="space"><b>${esc(d.grade)} - ${esc(gradeLabel(d.grade))} • ${esc(d.point)}</b><div><button class="tiny" onclick="editStagedDefect(${i})">Muuda</button>${!d.existingRow?`<button class="tiny" onclick="removeStaged(${i})">×</button>`:''}</div></div><div>${esc(d.desc)}</div><div class="small">${esc(d.owner||'Vastutaja puudub')} • ${esc(d.due||'')}${d.existingRow?' • olemasolev puudus':''}</div></div>`).join('');$('stagedCount').textContent=S.stagedDefects.length?` (${S.stagedDefects.length})`:'';
}
function editStagedDefect(i){const d=S.stagedDefects[i];addDefectForm();if(!$('dDesc'))return;TC.editDefectIndex=i;for(const [id,v] of [['dPoint',d.point],['dDesc',d.desc],['dGrade',d.grade],['dRepeat',d.repeat],['dOwner',d.owner],['dDue',d.due]])$(id).value=v||'';}
function stageDefect(){
  if(!$('dDesc'))return true;const desc=$('dDesc').value.trim(),grade=$('dGrade').value;if(!desc){toast('Kirjuta puuduse kirjeldus');return false;}if(!['A','B','C','D'].includes(grade)){toast('Vali puuduse aste');return false;}
  const i=TC.editDefectIndex;const d={...(i!=null?S.stagedDefects[i]:{}),point:$('dPoint').value,desc,grade,repeat:$('dRepeat').value,owner:$('dOwner').value.trim(),due:$('dDue').value};
  if(i!=null)S.stagedDefects[i]=d;else S.stagedDefects.push(d);TC.editDefectIndex=null;$('defectEditor').innerHTML='';renderStagedDefects();return true;
}
function removeStaged(i){if(S.stagedDefects[i]?.existingRow){toast('Olemasoleva puuduse saab sulgeda PARANDUSED vaates');return;}S.stagedDefects.splice(i,1);renderStagedDefects();}
function clearInput(doc,col,row){const c=getCell(doc,col+row);if(c&&!isFormulaCell(c)){clearCellContent(c);c.removeAttribute('t');}}
async function ensureTimeStyles(){
  const path='xl/styles.xml',doc=parseXml(await S.zip.file(path).async('string')),root=doc.documentElement,ns=root.namespaceURI;
  let fmts=qsa(doc,'numFmts')[0];if(!fmts){fmts=doc.createElementNS(ns,'numFmts');root.insertBefore(fmts,root.firstChild);}
  const xfs=qsa(doc,'cellXfs')[0];if(!xfs)throw Error('XLSX stiilid puuduvad');
  const styles={};for(const [name,code] of [['time','yyyy-mm-dd hh:mm:ss'],['duration','[HH]:MM:SS']]){
    let fmt=qsa(fmts,'numFmt').find(x=>x.getAttribute('formatCode')===code);if(!fmt){fmt=doc.createElementNS(ns,'numFmt');fmt.setAttribute('numFmtId',String(Math.max(163,...qsa(fmts,'numFmt').map(x=>Number(x.getAttribute('numFmtId'))))+1));fmt.setAttribute('formatCode',code);fmts.appendChild(fmt);}
    let list=qsa(xfs,'xf'),index=list.findIndex(x=>x.getAttribute('numFmtId')===fmt.getAttribute('numFmtId'));if(index<0){const x=list[0].cloneNode(true);x.setAttribute('numFmtId',fmt.getAttribute('numFmtId'));x.setAttribute('applyNumberFormat','1');xfs.appendChild(x);index=list.length;}styles[name]=index;
  }fmts.setAttribute('count',String(qsa(fmts,'numFmt').length));xfs.setAttribute('count',String(qsa(xfs,'xf').length));S.zip.file(path,xmlStr(doc));return styles;
}
async function saveInspection(goNext=false){
  if(TC.busy||!TC.ready||!S.selected||!TC.opened)return;
  const c=S.selected,status=$('cabStatus').value;if(!isActiveCabinet({...c,status})){if(status!==c.status)await saveCabinetStatus();else toast('See kilp ei kuulu aktiivsesse kontrolli');return;}
  if(inspectionSeconds()<getMinInspectionSeconds()){tickInspection();toast('Kontrolli minimaalne aeg ei ole täidetud');return;}
  const inspector=$('inspector').value.trim();if(!inspector){toast('Sisesta kontrollija');return;}if(!validateInspectionBeforeSave())return;
  if($('dDesc')&&!stageDefect())return;if(!await ensurePresence())return;
  const opened=TC.opened,date=$('inspectionDate').value||localDateIso();if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){toast('Kontrolli kuupäev on vigane');return;}
  const duration=inspectionSeconds(),ended=new Date(),start=new Date(opened.startedAt),wasEdit=!!opened.existing,wasNewDuplicate=!!opened.forceNew;
  const ok=await transaction(async()=>{
    const ctr=await loadDoc('Kontrollid'),def=await loadDoc('Puudused'),styles=await ensureTimeStyles();
    const row=opened.existing?.row||firstEmptyRow(ctr,'B',5,Math.max(10000,...qsa(ctr,'row').map(x=>Number(x.getAttribute('r'))))+1);
    if(opened.existing&&getCellVal(ctr,'B',row)!==c.id)throw Error('Kontrolli rida on muutunud');
    setDate(ctr,'A',row,date);setInline(ctr,'B',row,c.id);setInline(ctr,'D',row,inspector);
    for(const [col,val] of [['C',c.area],['E',c.panel],['F',c.device],['G',c.location]])if(!isFormulaCell(getCell(ctr,col+row)))setInline(ctr,col,row,val);
    for(const [col] of CHECKS){const v=String(S.ratings[col]??'');if(v!=='')setNum(ctr,col,row,Number(v));else clearInput(ctr,col,row);}
    if(!wasEdit||opened.existing.start===''){setDateTime(ctr,'W',row,start);ensureCell(ctr,'W',row).setAttribute('s',styles.time);}
    setDateTime(ctr,'X',row,ended);ensureCell(ctr,'X',row).setAttribute('s',styles.time);setNum(ctr,'Y',row,duration/86400);ensureCell(ctr,'Y',row).setAttribute('s',styles.duration);
    S.zip.file(S.paths.Kontrollid,xmlStr(ctr));
    const linked=TC.cycle.entries[c.id]?.defectRows||[],defectRows=[...linked];
    for(const d of S.stagedDefects){
      let rr=d.existingRow;
      if(rr){if(getCellVal(def,'B',rr)!==c.id||getCellVal(def,'M',rr))throw Error('Puudus on vahepeal muutunud või suletud');}
      else{rr=firstEmptyRow(def,'B',5,Math.max(10000,...qsa(def,'row').map(x=>Number(x.getAttribute('r'))))+1);setDate(def,'A',rr,date);setInline(def,'B',rr,c.id);setInline(def,'E',rr,inspector);for(const [col,val] of [['C',cabinetTitle(c)],['D',c.location]])if(!isFormulaCell(getCell(def,col+rr)))setInline(def,col,rr,val);defectRows.push(rr);}
      for(const [col,val] of [['F',d.point],['G',d.desc],['H',d.grade],['I',d.repeat],['J',d.owner]])setInline(def,col,rr,val||'');if(d.due)setDate(def,'K',rr,d.due);else clearInput(def,'K',rr);
    }
    if(S.stagedDefects.length)S.zip.file(S.paths.Puudused,xmlStr(def));
    if(status!==c.status){const sum=await loadDoc('Kokkuvõte');setInline(sum,'H',c.row,status);S.zip.file(S.paths['Kokkuvõte'],xmlStr(sum));}
    const fingerprint=recordFingerprint({id:c.id,date,inspector,start:getCellVal(ctr,'W',row)});
    const priorEntry=TC.cycle.entries[c.id]||{},oldControl=priorEntry.kontrollId||TC.records.find(r=>r.id===c.id&&r.row===priorEntry.row&&(!priorEntry.fingerprint||recordFingerprint(r)===priorEntry.fingerprint))?.syncId;
    const additionalIds=new Set(priorEntry.additionalKontrollIds||[]);if(wasNewDuplicate&&oldControl)additionalIds.add(oldControl);
    const previousControlDefects={...(priorEntry.previousControlDefects||{})};if(wasNewDuplicate&&oldControl&&priorEntry.defectRows?.length)previousControlDefects[oldControl]=[...new Set([...(previousControlDefects[oldControl]||[]),...priorEntry.defectRows])];
    TC.cycle.entries[c.id]={...priorEntry,row,fingerprint,defectRows:[...new Set(wasNewDuplicate?defectRows.filter(x=>!priorEntry.defectRows?.includes(x)):defectRows)],note:$('inspectComment').value,...(wasNewDuplicate&&additionalIds.size?{additionalKontrollIds:[...additionalIds]}:{}),...(Object.keys(previousControlDefects).length?{previousControlDefects}:{})};
    if(TC.guard.pending&&opened.proved){TC.guard.pending=null;TC.guard.remaining=randomGap();}else if(!opened.proved&&!wasEdit)TC.guard.remaining=Math.max(1,TC.guard.remaining-1);
    S.inspector=inspector;S.dirty=true;
  });
  if(ok){stopInspectionTimer();TC.opened=null;toast(`${c.id} ${wasEdit?'muudatused ':''}salvestatud telefoni • ${Math.round(duration)} s`);if(goNext)openNextCabinet(c.id);else showTab('cab');}
}
async function saveCabinetStatus(){if(TC.busy||!S.selected)return;const c=S.selected,status=$('cabStatus').value;if(await transaction(async()=>{const sum=await loadDoc('Kokkuvõte');setInline(sum,'H',c.row,status);S.zip.file(S.paths['Kokkuvõte'],xmlStr(sum));S.dirty=true;})){TC.opened=null;showTab('cab');toast(c.id+' staatus salvestatud telefoni');}}
async function saveRepair(){
  if(TC.busy||!S.selectedDefect)return;const d=S.selectedDefect,repairer=$('repairer').value.trim(),work=$('repairWork').value.trim();if(!repairer||!work){toast('Sisesta töö teostaja ja tehtud töö');return;}if(!confirm(d.id+'\nMärkida puudus parandatuks?'))return;
  if(await transaction(async()=>{const def=await loadDoc('Puudused');if(getCellVal(def,'B',d.row)!==d.id||getCellVal(def,'M',d.row))throw Error('Puudus on juba suletud või muutunud');const now=new Date(),styles=await ensureTimeStyles();setInline(def,'L',d.row,repairer);setDateTime(def,'M',d.row,now);ensureCell(def,'M',d.row).setAttribute('s',styles.time);setInline(def,'O',d.row,localTimeText(now)+' • '+work);S.zip.file(S.paths.Puudused,xmlStr(def));S.inspector=repairer;S.dirty=true;})){S.selectedDefect=null;showTab('def');toast('Parandus salvestatud telefoni');}
}
function timestampedName(){const d=new Date(),pad=n=>String(n).padStart(2,'0');let stem=S.fileName.replace(/\.xlsx$/i,'').replace(/\s*\(\d+\)$/,'').replace(/(?:_\d{2}\.\d{2}\.\d{4}|_\d{4}-\d{2}-\d{2}(?:_\d{2}[-:]?\d{2}(?:-\d{2})?)?)+$/,'');return `${stem}_${localDateIso(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.xlsx`;}
async function exportXlsx(){
  if(TC.busy||TC.exportPending||!S.zip)return;setBusy(true);
  try{const bytes=await persistWorkspace(),name=timestampedName(),mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';TC.exportPending=true;
    if(window.Android&&typeof Android.beginSaveFile==='function')await exportXlsxNative(bytes,name,mime);
    else{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([bytes],{type:mime}));a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);await onNativeExportFinished(true,'XLSX koopia eksporditud');}
  }catch(e){TC.exportPending=false;alert('Eksport ebaõnnestus. Telefonis salvestatud töö jäi alles.\n'+e.message);}finally{setBusy(false);}
}
async function shareXlsxNative(bytes,name,mime){
  if(!window.Android||typeof Android.beginShareFile!=='function')throw Error('Androidi jagamismenüü pole saadaval.');
  if(!Android.beginShareFile(name,mime))throw Error('Jagatava faili ettevalmistamine ebaõnnestus.');
  const chunkSize=196608;for(let i=0;i<bytes.length;i+=chunkSize)if(!Android.writeShareChunk(bytesToBase64(bytes.subarray(i,Math.min(i+chunkSize,bytes.length)))))throw Error('Jagatava faili kirjutamine ebaõnnestus.');
  if(!Android.finishShareFile())throw Error('Androidi jagamismenüüd ei saanud avada.');
}
async function shareXlsx(){
  if(TC.busy||TC.exportPending||!S.zip)return;setBusy(true);
  try{const bytes=await persistWorkspace(),name=timestampedName(),mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if(window.Android&&typeof Android.beginShareFile==='function')await shareXlsxNative(bytes,name,mime);
    else if(navigator.share&&typeof File==='function')await navigator.share({files:[new File([bytes],name,{type:mime})],title:'DOLD TechControl'});
    else throw Error('See seade ei paku failide jagamist. Kasuta XLSX eksporti.');
    renderCyclePanel();toast('Tööfail on Androidi jagamismenüüs valmis',4000);
  }catch(e){if(e?.name!=='AbortError')alert('Jagamine ebaõnnestus. Telefoni salvestatud töö jäi alles.\n'+e.message);}
  finally{setBusy(false);}
}
function onNativeShareFinished(ok,message){if(ok)toast(message||'Jagamismenüü avati',3000);else alert('Jagamine ebaõnnestus. Telefoni salvestatud töö jäi alles.\n'+(message||''));}
async function summarizeWorkbookBytes(bytes,name,cycle,meta={}){
  const savedS={...S},savedTC={...TC};
  try{TC.cycle=cycle?cloneData(cycle):null;TC.records=[];TC.allDefects=[];await loadBook(bytes,name);return captureWorkspaceSummary(meta);}
  finally{Object.assign(S,savedS);Object.assign(TC,savedTC);}
}
function workPackageName(){const d=new Date(),p=n=>String(n).padStart(2,'0');return `DOLD_TechControl_${localDateIso(d)}_${p(d.getHours())}-${p(d.getMinutes())}.dtc`;}
async function createWorkPackageBytes(){
  if(!S.zip||!TC.dbId)throw Error('Enne töö üleandmist ava töövihik.');
  const workbookBytes=await persistWorkspace(),snapshot=TC.startupSnapshot;
  const summary=await summarizeWorkbookBytes(workbookBytes,S.fileName,snapshot.cycle,{updatedAt:snapshot.updatedAt,revision:snapshot.revision});
  snapshot.summary=summary;await storeCall('put',snapshot);
  const baseBytes=snapshot.baseWorkbookBase64?decode64(snapshot.baseWorkbookBase64):null;
  const cycle=cloneData(snapshot.cycle||null),checkedIds=Object.keys(cycle?.entries||{}).sort();
  const state={schema:1,dbId:snapshot.dbId,fileName:snapshot.fileName,registryKey:snapshot.registryKey,registryTokens:snapshot.registryTokens,cycle,checkedIds,sync:snapshot.sync||null,guard:snapshot.guard,revision:snapshot.revision,updatedAt:snapshot.updatedAt,lastUsedAt:snapshot.lastUsedAt,sourceHash:snapshot.sourceHash,workbookHash:snapshot.workbookHash,inspector:snapshot.inspector,dirty:snapshot.dirty,summary,baseWorkbookSha256:baseBytes?await digest(baseBytes):null};
  const stateBytes=new TextEncoder().encode(JSON.stringify(state)),workbookHash=await digest(workbookBytes),stateHash=await digest(stateBytes),baseHash=baseBytes?await digest(baseBytes):null;
  const zip=new JSZip();zip.file('workbook.xlsx',workbookBytes);zip.file('state.json',stateBytes);if(baseBytes)zip.file('base-workbook.xlsx',baseBytes);
  const manifest={format:'DOLD-TECHCONTROL-WORK-PACKAGE',version:1,createdAt:new Date().toISOString(),sourceAppVersion:APP_VERSION,dbId:state.dbId,fileName:state.fileName,workbook:{path:'workbook.xlsx',sha256:workbookHash,size:workbookBytes.length},state:{path:'state.json',dbId:state.dbId,sha256:stateHash,size:stateBytes.length},baseWorkbook:baseBytes?{path:'base-workbook.xlsx',sha256:baseHash,size:baseBytes.length}:null,summary};
  zip.file('manifest.json',JSON.stringify(manifest,null,2));return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
}
async function shareWorkPackage(){
  if(TC.busy||!S.zip||!TC.dbId)return;setBusy(true);
  try{const bytes=await createWorkPackageBytes(),name=workPackageName();if(window.Android&&typeof Android.beginShareFile==='function')await shareXlsxNative(bytes,name,WORK_PACKAGE_MIME);else if(navigator.share&&typeof File==='function')await navigator.share({files:[new File([bytes],name,{type:WORK_PACKAGE_MIME})],title:'DOLD TechControl töö üleandmine'});else throw Error('Selles telefonis puudub failide jagamise võimalus.');toast('Tööpakett on Androidi jagamismenüüs valmis',4000);renderCyclePanel();}
  catch(e){if(e?.name!=='AbortError')alert('Töö üleandmine ebaõnnestus. Telefoni töö jäi alles.\n'+e.message);}finally{setBusy(false);}
}
const SYNC_PACKAGE_FORMAT='DOLD-TECHCONTROL-SYNC-PACKAGE';
const SYNC_PACKAGE_MIME='application/zip';
function syncOpsSummary(ops){
  const out={newControls:0,newDefects:0,repairedDefects:0,otherChanges:0,total:ops.length};
  for(const op of ops){if(op.action==='ADD_KONTROLL')out.newControls++;else if(op.action==='ADD_PUUDUS')out.newDefects++;else if(op.action==='CLOSE_PUUDUS')out.repairedDefects++;else out.otherChanges++;}
  return out;
}
function syncSummaryHtml(s){return `+ ${Number(s.newControls)||0} kontrolli<br>+ ${Number(s.newDefects)||0} uut puudust<br>${Number(s.repairedDefects)||0} parandatud puudust<br>${Number(s.otherChanges)||0} muud muudatust`;}
function syncPackageName(mode){const d=new Date(),p=n=>String(n).padStart(2,'0'),kind=mode==='baseline'?'BASELINE':'SYNC';return `DOLD_TechControl_${kind}_${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.dtcs`;}
async function createSyncBaselineBytes(){
  if(!S.zip||!TC.dbId||!TC.sync)throw Error('Enne teise telefoni ettevalmistamist ava XLSX tööfail.');
  const workbookBytes=await persistWorkspace(),snapshot=TC.startupSnapshot,workbookHash=await digest(workbookBytes),summary=await summarizeWorkbookBytes(workbookBytes,S.fileName,snapshot.cycle,{updatedAt:snapshot.updatedAt,revision:snapshot.revision});
  const state={schema:1,dbId:snapshot.dbId,fileName:snapshot.fileName,registryKey:snapshot.registryKey,registryTokens:snapshot.registryTokens,cycle:snapshot.cycle,sync:snapshot.sync,revision:snapshot.revision,updatedAt:snapshot.updatedAt,sourceHash:snapshot.sourceHash,workbookHash,inspector:snapshot.inspector,dirty:snapshot.dirty,summary};
  const stateBytes=new TextEncoder().encode(JSON.stringify(state)),stateHash=await digest(stateBytes),zip=new JSZip();zip.file('workbook.xlsx',workbookBytes);zip.file('state.json',stateBytes);
  const manifest={format:SYNC_PACKAGE_FORMAT,version:1,mode:'baseline',createdAt:new Date().toISOString(),sourceAppVersion:APP_VERSION,dbId:state.dbId,epoch:state.sync.epoch,senderDeviceId:TC.deviceId,fileName:state.fileName,workbook:{path:'workbook.xlsx',sha256:workbookHash,size:workbookBytes.length},state:{path:'state.json',sha256:stateHash,size:stateBytes.length},summary};
  zip.file('manifest.json',JSON.stringify(manifest,null,2));return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
}
async function createSyncDeltaBytes(){
  if(!S.zip||!TC.dbId||!TC.sync)throw Error('Enne muudatuste saatmist ava XLSX tööfail.');
  await persistWorkspace();const operations=cloneData(TC.sync.journal),operationsBytes=new TextEncoder().encode(JSON.stringify(operations)),operationsHash=await digest(operationsBytes),summary=syncOpsSummary(operations),zip=new JSZip();zip.file('operations.json',operationsBytes);
  const manifest={format:SYNC_PACKAGE_FORMAT,version:1,mode:'delta',createdAt:new Date().toISOString(),sourceAppVersion:APP_VERSION,dbId:TC.dbId,epoch:TC.sync.epoch,senderDeviceId:TC.deviceId,operations:{path:'operations.json',sha256:operationsHash,size:operationsBytes.length,count:operations.length},summary};
  zip.file('manifest.json',JSON.stringify(manifest,null,2));return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
}
async function shareSyncBytes(bytes,name,title){
  if(window.Android&&typeof Android.beginShareFile==='function')await shareXlsxNative(bytes,name,SYNC_PACKAGE_MIME);
  else if(navigator.share&&typeof File==='function')await navigator.share({files:[new File([bytes],name,{type:SYNC_PACKAGE_MIME})],title});
  else throw Error('Selles telefonis puudub jagamise võimalus.');
}
async function shareSyncBaseline(){
  if(TC.busy||!S.zip)return;setBusy(true);
  try{const bytes=await createSyncBaselineBytes(),name=syncPackageName('baseline');await shareSyncBytes(bytes,name,'DOLD TechControl teise telefoni algseis');toast('Teise telefoni algseis on jagamiseks valmis',4500);renderSyncStatus();}
  catch(e){if(e?.name!=='AbortError')alert('Teise telefoni ettevalmistamine ebaõnnestus. Telefoni töö jäi alles.\n'+e.message);}finally{setBusy(false);}
}
async function shareSyncDelta(){
  if(TC.busy||!S.zip)return;setBusy(true);
  try{const bytes=await createSyncDeltaBytes(),name=syncPackageName('delta');await shareSyncBytes(bytes,name,'DOLD TechControl muudatuste sünkroonimine');toast('Muudatuste pakett on jagamiseks valmis',4500);renderSyncStatus();}
  catch(e){if(e?.name!=='AbortError')alert('Muudatuste saatmine ebaõnnestus. Telefoni töö jäi alles.\n'+e.message);}finally{setBusy(false);}
}
function receiveSyncPackage(){selectNewWorkbook();}
function previewSyncOperations(operations){
  const saved=TC.sync,counts={newControls:0,newDefects:0,repairedDefects:0,otherChanges:0,newOperations:0,duplicates:0,conflicts:0};
  TC.sync=cloneData(saved);
  try{for(const op of operations){const plan=planSyncOperation(op);if(plan.duplicate){counts.duplicates++;continue;}counts.newOperations++;counts.conflicts+=plan.conflicts.length;if(op.action==='ADD_KONTROLL')counts.newControls++;else if(op.action==='ADD_PUUDUS')counts.newDefects++;else if(op.action==='CLOSE_PUUDUS')counts.repairedDefects++;else counts.otherChanges++;commitSyncOperation(op,plan);}}
  finally{TC.sync=saved;}
  return counts;
}
async function importSyncBaseline(archive,manifest,file){
  if(TC.dbId&&S.zip)throw Error('See telefon on juba tööfailiga ette valmistatud. Jätka selle tööga või kasuta tavapärast töö üleandmist.');
  const stateFile=archive.file(manifest.state?.path||'state.json'),workbookFile=archive.file(manifest.workbook?.path||'workbook.xlsx');if(!stateFile||!workbookFile)throw Error('Baaspaketist puudub töövihik või oleku fail.');
  const stateBytes=await stateFile.async('uint8array'),workbookBytes=await workbookFile.async('uint8array');
  if(stateBytes.length!==manifest.state.size||await digest(stateBytes)!==manifest.state.sha256)throw Error('Baaspaketi oleku kontrollsumma ei klapi.');
  if(workbookBytes.length!==manifest.workbook.size||await digest(workbookBytes)!==manifest.workbook.sha256)throw Error('Baaspaketi XLSX kontrollsumma ei klapi.');
  const state=JSON.parse(new TextDecoder().decode(stateBytes));if(state.schema!==1||!state.dbId||state.dbId!==manifest.dbId||!state.sync||state.sync.schema!==1||state.sync.dbId!==state.dbId||state.sync.epoch!==manifest.epoch)throw Error('Baaspaketi andmebaasi tunnus või sünkroonimise algseis ei klapi.');
  if(state.workbookHash!==manifest.workbook.sha256)throw Error('Baaspaketi olek viitab teisele XLSX töövihikule.');
  const cycleIds=Object.keys(state.cycle?.entries||{}).sort(),checkedIds=(state.checkedIds||cycleIds).slice().sort();if(cycleIds.length!==checkedIds.length||cycleIds.some((id,i)=>id!==checkedIds[i]))throw Error('Baaspaketi kontrolli edenemise ID-d ei klapi.');
  const incomingSummary=await summarizeWorkbookBytes(workbookBytes,state.fileName||manifest.fileName||file.name,state.cycle,{updatedAt:state.updatedAt,revision:state.revision});
  for(const key of ['controlCount','defectCount','openDefects','activeCount','checkedCount'])if(Number(incomingSummary[key])!==Number(state.summary?.[key]))throw Error('Baaspaketi kokkuvõte ei klapi töövihikuga ('+key+').');
  const choice=await showAppChoice('VALMISTA TEINE TELEFON',`Seade saab sama dbId ja sünkroonimise algseisu. Selle telefoni deviceId jääb eraldi.<div class="topgap">${summaryBlock('SAABUV BAAS',incomingSummary)}</div><p class="topgap">Pärast seda saab mõlemas telefonis paralleelselt töötada ja muudatusi vahetada.</p>`,[{value:'initialize',label:'VALMISTA ETTE',primary:true},{value:'cancel',label:'TÜHISTA'}]);
  if(choice!=='initialize')return;
  const snapshot={schema:1,dbId:state.dbId,fileName:state.fileName||manifest.fileName||file.name,registryKey:state.registryKey||'',registryTokens:state.registryTokens||[],cycle:state.cycle||null,sync:state.sync,guard:{remaining:randomGap(),pending:null},revision:Number(state.revision)||0,updatedAt:state.updatedAt||manifest.createdAt,lastUsedAt:new Date().toISOString(),sourceHash:state.sourceHash||manifest.workbook.sha256,baseWorkbookBase64:bytesToBase64(workbookBytes),inspector:state.inspector||'',dirty:!!state.dirty,workbookHash:manifest.workbook.sha256,summary:incomingSummary,workbookBase64:bytesToBase64(workbookBytes)};
  await storeCall('put',snapshot);Object.assign(TC,{dbId:snapshot.dbId,registryKey:snapshot.registryKey,registryTokens:snapshot.registryTokens,cycle:snapshot.cycle,sync:snapshot.sync,guard:snapshot.guard,revision:snapshot.revision,updatedAt:snapshot.updatedAt,localUsedAt:snapshot.lastUsedAt,sourceHash:snapshot.sourceHash,baseWorkbookBase64:snapshot.baseWorkbookBase64,ready:false,opened:null,pending:{notice:'Teise telefoni baastöö vastu võetud.'}});
  S.inspector=snapshot.inspector;S.dirty=snapshot.dirty;S.stagedDefects=[];await loadBook(workbookBytes,snapshot.fileName);TC.startupLoaded=true;TC.startupSnapshot=snapshot;TC.startupError='';TC.startupWarning='';TC.activated=true;
  $('workTabs').classList.remove('hidden');$('exportBtn').disabled=false;$('shareXlsxBtn').disabled=false;$('sharePackageBtn').disabled=false;$('workbookImportCard').classList.add('hidden');loadMinInspectionSetting();await persistWorkspace();renderStartupWorkspace();renderCyclePanel();showTab('home');toast('Telefon on paralleelseks tööks ette valmistatud',4500);
}
async function importSyncPackage(ev){
  if(TC.startupTask)await TC.startupTask;const file=ev.target.files?.[0];if(!file||TC.busy)return;setBusy(true);
  try{
    const bytes=new Uint8Array(await file.arrayBuffer()),archive=await JSZip.loadAsync(bytes,{checkCRC32:true}),mf=archive.file('manifest.json');if(!mf)throw Error('Sünkroonimispaketist puudub manifest.');
    const manifest=JSON.parse(await mf.async('string'));if(manifest.format!==SYNC_PACKAGE_FORMAT||manifest.version!==1||!['baseline','delta'].includes(manifest.mode))throw Error('Seda sünkroonimispaketi versiooni ei toetata.');
    if(manifest.mode==='baseline'){await importSyncBaseline(archive,manifest,file);return;}
    if(!TC.dbId||!TC.sync||!S.zip)throw Error('Ava esmalt sama andmebaasi tööfail või valmista telefon baaspaketiga ette.');
    if(manifest.dbId!==TC.dbId)throw Error('Need tööfailid ei kuulu samasse andmebaasi.');
    if(manifest.epoch!==TC.sync.epoch)throw Error('Sünkroonimispakett kuulub teise tööbaasi algseisu. Valmista teine telefon uuesti ette.');
    const opFile=archive.file(manifest.operations?.path||'operations.json');if(!opFile)throw Error('Sünkroonimispaketist puuduvad muudatused.');
    const opBytes=await opFile.async('uint8array');if(opBytes.length!==manifest.operations.size||await digest(opBytes)!==manifest.operations.sha256)throw Error('Sünkroonimispaketi kontrollsumma ei klapi.');
    const operations=JSON.parse(new TextDecoder().decode(opBytes));if(!Array.isArray(operations)||operations.length!==manifest.operations.count)throw Error('Sünkroonimispaketi muudatuste loend on vigane.');
    const preview=previewSyncOperations(operations),sum={newControls:preview.newControls,newDefects:preview.newDefects,repairedDefects:preview.repairedDefects,otherChanges:preview.otherChanges};
    const body=`<b>TEISEST TELEFONIST:</b><div class="topgap">${syncSummaryHtml(sum)}</div><div class="topgap"><b>SELLES TELEFONIS:</b><br>${localPendingSyncCount()} saatmata muudatust</div><div class="topgap"><b>Lisandub või uueneb:</b> ${preview.newOperations}<br><b>Vastuolusid:</b> ${preview.conflicts}<br><b>Juba olemas:</b> ${preview.duplicates}</div>`;
    const choice=await showAppChoice('SÜNKROONIMINE',body,[{value:'sync',label:preview.conflicts?'SÜNKROONI JA LAHENDA VASTUOLUD':'SÜNKROONI',primary:true},{value:'cancel',label:'TÜHISTA'}]);
    if(choice!=='sync')return;
    setBusy(false);const report=await applySyncOperations(operations,manifest.senderDeviceId||'');if(report.conflicts)await resolvePendingSyncConflicts();
    await showAppChoice('SÜNKROONITUD',`Saadud:<br>${syncSummaryHtml(sum)}<div class="topgap">Telefoni enda muudatused säilitati.<br>Rakendatud: ${report.applied} • Juba olemas: ${report.duplicates} • Vastuolusid lahendati: ${report.conflicts}</div>`,[{value:'done',label:'JÄTKA',primary:true}]);
    renderSyncStatus();
  }catch(e){alert('Sünkroonimine ebaõnnestus. Telefoni senine töö jäi alles.\n'+e.message);}
  finally{setBusy(false);ev.target.value='';}
}
function receiveWorkPackage(){selectNewWorkbook();}
async function importWorkPackage(ev){
  if(TC.startupTask)await TC.startupTask;const file=ev.target.files?.[0];if(!file||TC.busy)return;setBusy(true);
  try{
    const packageBytes=new Uint8Array(await file.arrayBuffer()),archive=await JSZip.loadAsync(packageBytes,{checkCRC32:true});
    const manifestFile=archive.file('manifest.json'),stateFile=archive.file('state.json');if(!manifestFile||!stateFile)throw Error('Tööpaketis puudub manifest või rakenduse olek.');
    const manifest=JSON.parse(await manifestFile.async('string')),stateBytes=await stateFile.async('uint8array');
    if(manifest.format!=='DOLD-TECHCONTROL-WORK-PACKAGE'||manifest.version!==1)throw Error('Seda DOLD tööpaketi versiooni ei toetata.');
    const workbookEntry=archive.file(manifest.workbook?.path||'workbook.xlsx');if(!workbookEntry)throw Error('Tööpaketis puudub töövihik.');
    const workbookBytes=await workbookEntry.async('uint8array');if(manifest.workbook?.size&&workbookBytes.length!==manifest.workbook.size)throw Error('Töövihiku suurus ei klapi.');if(await digest(workbookBytes)!==manifest.workbook?.sha256)throw Error('Töövihiku kontrollsumma ei klapi. Pakett võib olla rikutud.');
    if(manifest.state?.size&&stateBytes.length!==manifest.state.size)throw Error('Rakenduse oleku suurus ei klapi.');if(await digest(stateBytes)!==manifest.state?.sha256)throw Error('Rakenduse oleku kontrollsumma ei klapi. Pakett võib olla rikutud.');
    const state=JSON.parse(new TextDecoder().decode(stateBytes));if(state.schema!==1||!state.dbId||state.dbId!==manifest.dbId||state.dbId!==manifest.state?.dbId)throw Error('Tööpaketi andmebaasi tunnus ei klapi.');
    if(state.workbookHash&&state.workbookHash!==manifest.workbook.sha256)throw Error('Rakenduse olek viitab teisele XLSX failile.');
    let baseBytes=null;if(manifest.baseWorkbook){const baseEntry=archive.file(manifest.baseWorkbook.path||'base-workbook.xlsx');if(!baseEntry)throw Error('Tööpaketis puudub XLSX baaskoopia.');baseBytes=await baseEntry.async('uint8array');if(manifest.baseWorkbook.size&&baseBytes.length!==manifest.baseWorkbook.size)throw Error('XLSX baaskoopia suurus ei klapi.');if(await digest(baseBytes)!==manifest.baseWorkbook.sha256||state.baseWorkbookSha256&&state.baseWorkbookSha256!==manifest.baseWorkbook.sha256)throw Error('XLSX baaskoopia kontrollsumma ei klapi.');}
    const cycleIds=Object.keys(state.cycle?.entries||{}).sort(),checkedIds=(state.checkedIds||cycleIds).slice().sort();if(cycleIds.length!==checkedIds.length||cycleIds.some((id,i)=>id!==checkedIds[i]))throw Error('Kontrolli edenemise ID-d ei klapi rakenduse olekuga.');
    const incomingSummary=await summarizeWorkbookBytes(workbookBytes,state.fileName||manifest.fileName||file.name,state.cycle,{updatedAt:state.updatedAt||manifest.createdAt,revision:state.revision});
    for(const k of ['controlCount','defectCount','openDefects','activeCount','checkedCount'])if(Number(state.summary?.[k])!==Number(incomingSummary[k]))throw Error('Tööpaketi kokkuvõte ei klapi töövihiku ja kontrolli olekuga ('+k+').');
    let local=null;const currentId=TC.dbId;if(currentId){try{local=await storeCall('get',currentId);}catch(e){local=null;}}
    if(!local){const listed=await storeCall('list');if(Array.isArray(listed)&&listed.length){const latest=[...listed].sort((a,b)=>(Date.parse(b.lastUsedAt||b.updatedAt||'')||0)-(Date.parse(a.lastUsedAt||a.updatedAt||'')||0))[0];try{local=await storeCall('get',latest.dbId);}catch(e){local=null;}}}
    let choice='incoming';
    if(local){
      let localBytes=decode64(local.workbookBase64||'');if(!localBytes.length)throw Error('Telefonis oleva tööfaili sisu puudub.');
      if(local.workbookHash&&await digest(localBytes)!==local.workbookHash)throw Error('Telefonis oleva tööfaili kontrollsumma ei klapi.');
      const localSummary=await summarizeWorkbookBytes(localBytes,local.fileName||'Telefonis olev XLSX',local.cycle,{updatedAt:local.updatedAt,revision:local.revision});
      const relation=freshnessRelation(local,{dbId:state.dbId,revision:state.revision,updatedAt:state.updatedAt},localSummary,incomingSummary,false);
      const status=relation==='internal'?'Telefonis olev tööfail on uuem.':relation==='incoming'?'Saabuv tööpakett näib uuem.':'Versioonide järjestus ei ole kindel. Võrdle mõlemat kokkuvõtet.';
      const identityWarning=local.registryKey&&state.registryKey&&local.registryKey!==state.registryKey?'<p class="badge warn">Andmebaasi tunnus erineb. Kontrolli, et see on õige ettevõtte tööfail.</p>':'';
      choice=await showAppChoice('Võrdle tööpaketti',`<b>${esc(status)}</b><div class="topgap">${summaryBlock('TELEFONIS',localSummary)}</div><div class="topgap">${summaryBlock('SAABUV PAKETT',incomingSummary)}</div>${identityWarning}<p class="topgap">Telefonis olev töö asendatakse ainult siis, kui valid paketi vastuvõtu.</p>`,relation==='incoming'?[{value:'incoming',label:'VÕTA UUEM PAKETT VASTU',primary:true},{value:'internal',label:'JÄTKA TELEFONI TÖÖGA'},{value:'cancel',label:'TÜHISTA'}]:[{value:'internal',label:'JÄTKA TELEFONI TÖÖGA',primary:true},{value:'incoming',label:'VÕTA PAKETT VASTU JA ASENDA TELEFONI TÖÖ'},{value:'cancel',label:'TÜHISTA'}]);
    }else choice=await showAppChoice('Võta töö vastu',`Telefonis pole avatud tööfaili.<div class="topgap">${summaryBlock('SAABUV PAKETT',incomingSummary)}</div><p class="topgap">Vastuvõtt salvestab XLSX-i ja kontrolli oleku telefoni.</p>`,[{value:'incoming',label:'VÕTA TÖÖ VASTU',primary:true},{value:'cancel',label:'TÜHISTA'}]);
    if(choice!=='incoming'){toast('Tööpaketti ei võetud vastu. Telefoni andmeid ei muudetud.');return;}
    const snapshot={schema:1,dbId:state.dbId,fileName:state.fileName||manifest.fileName||'DOLD_TechControl.xlsx',registryKey:state.registryKey||'',registryTokens:state.registryTokens||[],cycle:state.cycle||null,sync:state.sync||null,guard:state.guard||{remaining:randomGap(),pending:null},revision:Number(state.revision)||0,updatedAt:state.updatedAt||manifest.createdAt,lastUsedAt:new Date().toISOString(),sourceHash:state.sourceHash||manifest.workbook.sha256,baseWorkbookBase64:baseBytes?bytesToBase64(baseBytes):'',inspector:state.inspector||'',dirty:!!state.dirty,workbookHash:manifest.workbook.sha256,summary:incomingSummary,workbookBase64:bytesToBase64(workbookBytes)};
    await storeCall('put',snapshot);
    Object.assign(TC,{dbId:snapshot.dbId,registryKey:snapshot.registryKey,registryTokens:snapshot.registryTokens,cycle:snapshot.cycle,sync:snapshot.sync,guard:snapshot.guard,revision:snapshot.revision,updatedAt:snapshot.updatedAt,localUsedAt:snapshot.lastUsedAt,sourceHash:snapshot.sourceHash,baseWorkbookBase64:snapshot.baseWorkbookBase64,ready:false,opened:null,pending:{notice:'Teiselt telefonilt vastu võetud tööpakett.'}});
    S.inspector=snapshot.inspector;S.dirty=snapshot.dirty;S.stagedDefects=[];await loadBook(workbookBytes,snapshot.fileName);TC.startupLoaded=true;TC.startupSnapshot=snapshot;TC.startupError='';TC.startupWarning='';TC.activated=true;TC.ready=false;
    $('workTabs').classList.remove('hidden');$('exportBtn').disabled=false;$('shareXlsxBtn').disabled=false;$('sharePackageBtn').disabled=false;$('workbookImportCard').classList.add('hidden');loadMinInspectionSetting();renderStartupWorkspace();renderCyclePanel();showTab('home');toast('Tööpakett vastu võetud. Puudused ja parandused on avatud.',4500);
  }catch(e){alert('Tööpaketi vastuvõtt ebaõnnestus. Telefoni eelmine töö jäi alles.\n'+e.message);}
  finally{setBusy(false);ev.target.value='';}
}
async function onNativeExportFinished(ok,message){TC.exportPending=false;if(ok){const alreadyBusy=TC.busy;setBusy(true);S.dirty=false;try{await persistWorkspace();renderCyclePanel();}catch(e){S.dirty=true;alert('Koopia eksporditud, kuid ekspordioleku salvestamine ebaõnnestus. Kontroll jäi alles.\n'+e.message);}finally{if(!alreadyBusy)setBusy(false);}toast(message||'XLSX koopia salvestatud',4000);}else alert((message||'Eksport tühistatud')+'\nTelefonis salvestatud kontroll jäi alles.');}
loadMinInspectionSetting();applyTheme();try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTheme);}catch(e){}
TC.startupTask=bootstrapSavedWorkspace();
