/* DOLD TechControl 0.5.6.1. Keeps the existing JSZip workbook editor and native QR scanner.
 * A save is acknowledged only after one atomic, complete native workspace commit.
 */
const TC = {schema:1, dbId:null, registryKey:'', registryTokens:[], cycle:null,
  guard:null, revision:0, updatedAt:null, sourceHash:'', ready:false, busy:false,
  records:[], allDefects:[], pending:null, opened:null, exportPending:false, baseWorkbookBase64:'',
  sync:null, deviceId:'', pendingSyncRowIds:null, pendingSemanticRows:null,
  signatureVersions:{},
  startupLoaded:false, activated:false, startupTask:null, startupError:''};
const META_NAME='DOLD.TechControl.v1';
const WORK_PACKAGE_FORMAT='DOLD-TECHCONTROL-WORK-PACKAGE';
const WORK_PACKAGE_MIME='application/vnd.dold.techcontrol.workpackage';
const SYNC_PACKAGE_MIME='application/vnd.dold.techcontrol.syncpackage';
const APP_VERSION='0.5.6.1';
const cloneData=v=>JSON.parse(JSON.stringify(v));
function persistentSyncId(type,value){
  const prefixes={Kontroll:'dtc-kontroll-',Puudus:'dtc-puudus-',Cabinet:'dtc-cabinet-'},prefix=prefixes[type],id=String(value??'').trim();
  return prefix&&id.startsWith(prefix)&&/^[A-Za-z0-9_-]{1,180}$/.test(id.slice(prefix.length))?id:'';
}
function newPersistentSyncId(type){const prefix={Kontroll:'dtc-kontroll-',Puudus:'dtc-puudus-'}[type];if(!prefix)throw Error('Tundmatu püsiva ID liik.');return prefix+uid();}
let appDialogResolve=null;
let pendingPostSaveSignatureNavigation=null;
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
  const link=TC.cycle?.entries?.[r.id],primaryId=persistentSyncId('Kontroll',link?.kontrollId),isPrimary=!!primaryId&&primaryId===r.syncId,isAdditional=cycleEntryControlIds(link).includes(r.syncId)&&!isPrimary;
  if(link&&(isPrimary||isAdditional||(!primaryId&&link.fingerprint===recordFingerprint(r)))){values.cycleId=TC.cycle.id;if(isPrimary||(!primaryId&&link.fingerprint===recordFingerprint(r)))values.note=link.note||'';}
  return values;
}
function syncDefectValues(d){
  const values={cabinetId:d.id,date:d.date,inspector:d.inspector,cabinetTitle:d.cabinetTitle||'',location:d.location||'',point:d.point||'',description:d.desc||'',priority:d.grade||'',repeat:d.repeat||'',owner:d.owner||'',due:d.due||'',repairer:d.repairer||'',closedAt:d.closedAt||'',repairAction:d.repairAction||'',lastCheckedBy:d.lastCheckedBy||''};
  const link=TC.cycle?.entries?.[d.id],knownControlIds=cycleEntryControlIds(link),linkedControlId=knownControlIds.includes(d.kontrollId)?d.kontrollId:'',priorControlId=linkedControlId&&link?.previousControlDefects?.[linkedControlId]?linkedControlId:Object.entries(link?.previousControlDefects||{}).find(([,rows])=>rows?.includes(d.row))?.[0],hasCurrentLink=!!(linkedControlId&&linkedControlId===persistentSyncId('Kontroll',link?.kontrollId)),legacyCurrentLink=!knownControlIds.length&&!!link?.defectRows?.includes(d.row),belongsToCycle=!!(hasCurrentLink||linkedControlId||legacyCurrentLink||priorControlId);
  const cycleControlId=linkedControlId||(legacyCurrentLink?(link.kontrollId||TC.records.find(r=>r.row===link.row&&r.id===d.id&&recordFingerprint(r)===link.fingerprint)?.syncId):priorControlId);
  const controlId=d.kontrollId||cycleControlId;
  if(controlId)values.kontrollId=controlId;
  if(link&&belongsToCycle)values.cycleId=TC.cycle.id;
  return values;
}
function syncCabinetValues(c){return {cabinetId:c.id,status:c.status||''};}
function syncCanonical(v){return JSON.stringify(v);}
function cycleEntryControlIds(link){
  if(!link||typeof link!=='object')return[];
  return [...new Set([persistentSyncId('Kontroll',link.kontrollId),...(Array.isArray(link.additionalKontrollIds)?link.additionalKontrollIds.map(id=>persistentSyncId('Kontroll',id)):[]),...Object.keys(link.previousControlDefects||{}).map(id=>persistentSyncId('Kontroll',id))].filter(Boolean))];
}
function controlEntityMatchesRecord(values,record){
  if(!values||String(values.cabinetId||'')!==String(record.id||'')||String(values.date||'')!==String(record.date||'')||String(values.inspector||'')!==String(record.inspector||''))return false;
  const oldStart=realStartFromRecord({date:values.date,start:values.start}),newStart=realStartFromRecord(record);
  return oldStart&&newStart?oldStart===newStart:String(values.start??'')===String(record.start??'');
}
function findCycleRecordByIds(cabinetId,link){
  const ids=cycleEntryControlIds(link),records=ids.map(id=>TC.records.find(r=>r.id===cabinetId&&r.syncId===id)||null);
  return {ids,primary:ids.length?records[0]:null,matched:records.filter(Boolean)};
}
function findLegacyCycleRecord(cabinetId,link){
  if(!link)return null;
  const byHint=TC.records.find(r=>r.id===cabinetId&&r.row===Number(link.row)&&(!link.fingerprint||recordFingerprint(r)===link.fingerprint));
  if(byHint)return byHint;
  if(link.fingerprint){
    const exact=TC.records.find(r=>r.id===cabinetId&&recordFingerprint(r)===link.fingerprint);if(exact)return exact;
    const parts=String(link.fingerprint).split('|'),date=parts[1]||'',inspector=parts[2]||'',oldStart=parts.slice(3).join('|'),targetStart=realStartFromRecord({id:cabinetId,date,inspector,start:oldStart});
    const near=TC.records.filter(r=>r.id===cabinetId&&r.date===date&&r.inspector===inspector&&targetStart&&realStartFromRecord(r)===targetStart);
    if(near.length===1)return near[0];
    if(!oldStart){const unique=TC.records.filter(r=>r.id===cabinetId&&r.date===date&&r.inspector===inspector);if(unique.length===1)return unique[0];}
  }
  return null;
}
function reconcileCycleDefectLinks(cabinetId,link){
  const ids=cycleEntryControlIds(link);if(!ids.length)return;
  const primaryId=persistentSyncId('Kontroll',link.kontrollId);
  const primaryRows=TC.allDefects.filter(d=>d.id===cabinetId&&d.kontrollId===primaryId).map(d=>d.row);
  if(primaryId&&primaryRows.length)link.defectRows=primaryRows;
  for(const controlId of ids){if(controlId===primaryId)continue;const rows=TC.allDefects.filter(d=>d.id===cabinetId&&d.kontrollId===controlId).map(d=>d.row);if(rows.length){link.previousControlDefects??={};link.previousControlDefects[controlId]=rows;}}
}
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
        const item=list[i],row=String(item.row),pending=TC.pendingSyncRowIds?.[type]?.[row],persistentId=persistentSyncId(type,item.persistentId);
        if(persistentId&&pending&&persistentId!==pending)throw Error('Tööfaili püsiv ID ei klapi sünkroonitud kirje ID-ga.');
        if(persistentId&&used.has(persistentId))throw Error('Tööfailis kordub püsiv kirje ID: '+persistentId);
        let key=base+'#'+(i+1),entityId=persistentId||pending;
        if(!entityId&&type==='Kontroll'){
          const linked=cycleEntryControlIds(TC.cycle?.entries?.[item.id]).filter(id=>!used.has(id)&&entities[id]&&controlEntityMatchesRecord(entities[id].values,item));
          if(linked.length===1)entityId=linked[0];
        }
        if(!entityId)entityId=Object.keys(entities).find(id=>!used.has(id)&&entities[id]?.key===key);
        if(!entityId&&type==='Kontroll'){
          const legacy=Object.keys(entities).filter(id=>!used.has(id)&&controlEntityMatchesRecord(entities[id]?.values,item));
          if(legacy.length===1)entityId=legacy[0];
        }
        if(entityId&&used.has(entityId))entityId=null;
        if(!entityId&&TC.pendingSyncRowIds)entityId=`dtc-${type.toLowerCase()}-new-${TC.deviceId.slice(-8)}-${uid()}`;
        if(!entityId){const seed=`${TC.dbId}|${type}|${key}`;entityId=`dtc-${type.toLowerCase()}-${(await digest(new TextEncoder().encode(seed))).slice(0,32)}`;if(used.has(entityId)){let n=i+1;do{key=base+'#'+(++n);entityId=`dtc-${type.toLowerCase()}-${(await digest(new TextEncoder().encode(`${TC.dbId}|${type}|${key}`))).slice(0,32)}`;}while(used.has(entityId));}}
        const old=entities[entityId]||{};entities[entityId]={...old,key,fieldVersions:old.fieldVersions||{},values:valuesOf(item)};used.add(entityId);item.syncId=entityId;
      }
    }
  };
  await assign('Kontroll',TC.records,syncControlBase,syncControlValues);
  let migratedCycleIdentity=false;
  for(const [cabinetId,link] of Object.entries(TC.cycle?.entries||{})){
    if(!link||typeof link!=='object')continue;
    const linked=findCycleRecordByIds(cabinetId,link);
    if(linked.primary){link.row=linked.primary.row;link.fingerprint=recordFingerprint(linked.primary);}
    else if(!linked.ids.length){const legacy=findLegacyCycleRecord(cabinetId,link);if(legacy&&legacy.syncId){link.kontrollId=legacy.syncId;link.row=legacy.row;link.fingerprint=recordFingerprint(legacy);migratedCycleIdentity=true;}}
    reconcileCycleDefectLinks(cabinetId,link);
  }
  if(migratedCycleIdentity)await assign('Kontroll',TC.records,syncControlBase,syncControlValues);
  await assign('Puudus',TC.allDefects,syncDefectBase,syncDefectValues);
  await assign('Cabinet',S.cabinets,c=>c.id,syncCabinetValues);
  reconcileCycle();
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
  const linked=[];for(const [id,link] of Object.entries(cycle?.entries||{})){const stable=findCycleRecordByIds(id,link);if(stable.ids.length){linked.push(...stable.matched);continue;}const legacy=findLegacyCycleRecord(id,link);if(legacy)linked.push(legacy);}
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
  return {fileName:S.fileName||'',objectCount:S.cabinets.length,controlCount:TC.records.length,defectCount:TC.allDefects.length,openDefects:S.existingDefects.length,activeCount:active.length,checkedCount:checked,latestInspection:stamp,latestInspectionKey:latest?rSortKey(latest):0,updatedAt:Object.hasOwn(meta,'updatedAt')?meta.updatedAt:(TC.updatedAt??null),revision:Object.hasOwn(meta,'revision')?meta.revision:(TC.revision??0)};
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
function bytesHaveZipSignature(bytes){return bytes?.length>=4&&bytes[0]===0x50&&bytes[1]===0x4b&&((bytes[2]===0x03&&bytes[3]===0x04)||(bytes[2]===0x05&&bytes[3]===0x06)||(bytes[2]===0x07&&bytes[3]===0x08));}
async function detectIncomingFileKind(bytes,fileName=''){
  const archiveName=/\.(?:dtc|dtcs|zip)$/i.test(fileName),zipSignature=bytesHaveZipSignature(bytes);
  if(!archiveName&&!zipSignature)return 'xlsx';
  let archive;
  try{archive=await JSZip.loadAsync(bytes,{checkCRC32:true});}
  catch(e){if(archiveName||zipSignature)throw Error('ZIP-fail on vigane või ei ole loetav. Tööbaasi ei muudetud.');return 'xlsx';}
  const manifestFile=archive.file('manifest.json');
  if(manifestFile){
    let manifest;try{manifest=JSON.parse(await manifestFile.async('string'));}catch(e){throw Error('DOLD-paketi manifest.json on vigane. Tööbaasi ei muudetud.');}
    if(manifest?.format===WORK_PACKAGE_FORMAT)return 'work-package';
    if(manifest?.format===SYNC_PACKAGE_FORMAT)return 'sync-package';
    throw Error('ZIP-faili manifesti vormingut ei tunta. Tööbaasi ei muudetud.');
  }
  if(archive.file('xl/workbook.xml')&&archive.file('[Content_Types].xml'))return 'xlsx';
  throw Error('ZIP-failist ei leitud DOLD-paketi manifesti ega XLSX töövihikut. Tööbaasi ei muudetud.');
}
async function handleImportFile(ev){
  const file=ev.target.files?.[0];if(!file)return;
  try{
    const bytes=new Uint8Array(await file.arrayBuffer()),kind=await detectIncomingFileKind(bytes,file.name);
    if(kind==='sync-package'){
      if(typeof processSyncPackageBytes==='function')return processSyncPackageBytes(bytes,file.name,()=>{ev.target.value='';});
      throw Error('Sünkroonimispaketi vastuvõtt pole saadaval.');
    }
    if(kind==='work-package'){
      if(typeof importWorkPackage==='function')return importWorkPackage(ev,bytes);
      throw Error('Tööpaketi vastuvõtt pole saadaval.');
    }
    return importXlsx(ev,bytes);
  }catch(e){alert('Faili avamine ebaõnnestus. Telefoni töö jäi alles.\n'+(e.message||String(e)));ev.target.value='';}
}
async function bootstrapSavedWorkspace(){
  try{
    const listed=await storeCall('list');const list=Array.isArray(listed)?listed:[];
    let issues=[];if(nativeStore()&&typeof Android.listWorkspaceErrors==='function'){try{const raw=JSON.parse(Android.listWorkspaceErrors());if(raw.ok&&Array.isArray(raw.data))issues=raw.data;}catch(e){issues=[];}}
    if(!list.length){TC.startupLoaded=false;TC.startupError=issues.length?'Telefonis olev tööfail on vigane. Vali töö jätkamiseks uuesti XLSX.':'';renderStartupWorkspace();renderSyncStatus();return;}
    TC.startupWarning=issues.length?'Mõnda telefoni salvestatud tööfaili ei saanud avada; saad jätkata viimase terve koopiaga.':'';
    const latest=[...list].sort((a,b)=>(Date.parse(b.lastUsedAt||b.updatedAt||'')||Number(b.revision)||0)-(Date.parse(a.lastUsedAt||a.updatedAt||'')||Number(a.revision)||0))[0];
    const snap=await storeCall('get',latest.dbId);if(!snap||snap.schema!==1||!snap.workbookBase64)throw Error('Sisemine XLSX töövihik puudub või on vigane.');
    const bytes=decode64(snap.workbookBase64);if(snap.workbookHash&&await digest(bytes)!==snap.workbookHash)throw Error('Sisemise XLSX faili kontrollsumma ei klapi.');
    Object.assign(TC,{dbId:snap.dbId,registryKey:snap.registryKey||'',registryTokens:snap.registryTokens||[],cycle:snap.cycle||null,sync:snap.sync||null,signatureVersions:normalizeSignatureVersionMap(snap.signatureVersions),guard:snap.guard||{remaining:randomGap(),pending:null},revision:Number(snap.revision)||0,updatedAt:snap.updatedAt||null,localUsedAt:snap.lastUsedAt||snap.updatedAt||null,sourceHash:snap.sourceHash||'',baseWorkbookBase64:snap.baseWorkbookBase64||'',ready:false,opened:null,pending:{notice:'Taastatud telefoni salvestatud tööfail.'}});
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
    const v=d.createElementNS(vt,'vt:lpwstr');v.textContent=JSON.stringify({schema:1,dbId:TC.dbId,registryKey:TC.registryKey,cycle:TC.cycle,revision:TC.revision,updatedAt:TC.updatedAt,inspector:S.inspector,sync:TC.sync||null,signatureVersions:normalizeSignatureVersionMap(TC.signatureVersions)});p.appendChild(v);S.zip.file(path,xmlStr(d));
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
  TC.records=qsa(ctr,'row').map(x=>Number(x.getAttribute('r'))).filter(r=>r>=5&&getCellVal(ctr,'B',r)).map(row=>{
    const persistentId=persistentSyncId('Kontroll',getCellVal(ctr,'AA',row));
    return {row,id:getCellVal(ctr,'B',row).trim(),date:excelDateToIso(getCellVal(ctr,'A',row)),inspector:getCellVal(ctr,'D',row).trim(),start:getCellVal(ctr,'W',row),end:getCellVal(ctr,'X',row),duration:Number(getCellVal(ctr,'Y',row))||0,exception:getCellVal(ctr,'Z',row),persistentId,syncId:persistentId,ratings:Object.fromEntries(CHECKS.map(([col])=>[col,getCellVal(ctr,col,row)]))};
  });
  TC.allDefects=qsa(def,'row').map(x=>Number(x.getAttribute('r'))).filter(r=>r>=5&&getCellVal(def,'B',r)).map(row=>{
    const persistentId=persistentSyncId('Puudus',getCellVal(def,'S',row)),linkStatus=String(getCellVal(def,'U',row)||'').trim(),kontrollId=persistentSyncId('Kontroll',getCellVal(def,'T',row));
    return {row,id:getCellVal(def,'B',row).trim(),date:excelDateToIso(getCellVal(def,'A',row)),inspector:getCellVal(def,'E',row),cabinetTitle:getCellVal(def,'C',row),location:getCellVal(def,'D',row),point:getCellVal(def,'F',row),desc:getCellVal(def,'G',row),grade:getCellVal(def,'H',row),repeat:getCellVal(def,'I',row),owner:getCellVal(def,'J',row),due:excelDateToIso(getCellVal(def,'K',row)),repairer:getCellVal(def,'L',row),closedAt:getCellVal(def,'M',row),repairAction:getCellVal(def,'O',row),lastCheckedBy:getCellVal(def,'P',row),persistentId,syncId:persistentId,kontrollId,linkStatus,linkBasis:String(getCellVal(def,'V',row)||'').trim(),legacyUnresolved:!persistentId&&linkStatus.toUpperCase()==='UNRESOLVED',closed:!!getCellVal(def,'M',row)};
  });
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
    const linked=findCycleRecordByIds(id,link);
    if(linked.ids.length){
      if(linked.primary){link.row=linked.primary.row;link.fingerprint=recordFingerprint(linked.primary);}
      if(linked.matched.length)S.sessionChecked.add(id);
      reconcileCycleDefectLinks(id,link);
      continue;
    }
    const legacy=findLegacyCycleRecord(id,link);
    if(legacy){link.row=legacy.row;link.fingerprint=recordFingerprint(legacy);if(legacy.syncId)link.kontrollId=legacy.syncId;S.sessionChecked.add(id);}
  }
  S.ringStartedAt=TC.cycle.startedAt;
}
function savedEntry(id){
  const link=TC.cycle?.entries?.[id];if(!link)return null;
  const ids=cycleEntryControlIds(link);
  if(ids.length){for(const controlId of ids){const record=TC.records.find(r=>r.syncId===controlId&&r.id===id);if(record)return record;}return null;}
  return findLegacyCycleRecord(id,link);
}
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
function validSyncOperationShape(op){
  if(!op||op.schema!==1||typeof op.opId!=='string'||typeof op.deviceId!=='string'||!/^device-[a-f0-9]{32}$/.test(op.deviceId)
    ||!Number.isSafeInteger(op.localSequence)||op.localSequence<1||op.opId!==`${op.deviceId}:${op.localSequence}`
    ||typeof op.entityType!=='string'||typeof op.entityId!=='string'||!/^dtc-(kontroll|puudus|cabinet)-[A-Za-z0-9_-]{1,180}$/.test(op.entityId)
    ||!op.changedFields||typeof op.changedFields!=='object'||Array.isArray(op.changedFields)||!Object.keys(op.changedFields).length)return false;
  const prefix={Kontroll:'dtc-kontroll-',Puudus:'dtc-puudus-',Cabinet:'dtc-cabinet-'}[op.entityType];if(!prefix||!op.entityId.startsWith(prefix))return false;
  const actions={Kontroll:['ADD_KONTROLL','UPDATE_KONTROLL'],Puudus:['ADD_PUUDUS','UPDATE_PUUDUS','CLOSE_PUUDUS'],Cabinet:['UPDATE_CABINET_STATUS']};if(!actions[op.entityType].includes(op.action))return false;
  const fields={Kontroll:['cabinetId','date','area','inspector','panel','device','location','start','end','duration','exception','cycleId','note',...CHECKS.map(([col])=>'score_'+col)],Puudus:['cabinetId','date','inspector','cabinetTitle','location','point','description','priority','repeat','owner','due','repairer','closedAt','repairAction','lastCheckedBy','cycleId','kontrollId'],Cabinet:['cabinetId','status']};
  if(Object.keys(op.changedFields).some(field=>!fields[op.entityType].includes(field)))return false;
  if(op.baseFieldVersions!=null&&(typeof op.baseFieldVersions!=='object'||Array.isArray(op.baseFieldVersions)))return false;
  if(op.resolvesFieldVersions!=null&&(typeof op.resolvesFieldVersions!=='object'||Array.isArray(op.resolvesFieldVersions)))return false;
  return true;
}
function planSyncOperation(op){
  if(!TC.sync||!validSyncOperationShape(op))throw Error('Sünkroonimistoiming on vigane.');
  if(op.dbId!==TC.dbId)throw Error('Need tööfailid ei kuulu samasse andmebaasi.');
  if(op.epoch!==TC.sync.epoch)throw Error('Sünkroonimispakett kuulub teise tööbaasi algseisu. Valmista teine telefon uuesti ette.');
  if(!['Kontroll','Puudus','Cabinet'].includes(op.entityType))throw Error('Sünkroonimistoimingu sisu ei ole toetatud.');
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
async function resolvePendingSyncConflicts(preselected={}){
  const pending=(TC.sync?.conflicts||[]).filter(c=>!c.resolved),decisions=[];
  for(const c of pending){const choice=preselected[c.conflictId]||await promptSyncConflict(c);if(!['local','remote'].includes(choice))throw Error('Vastuolu lahendamine katkestati. Telefoni senine töö jäi alles.');decisions.push({conflictId:c.conflictId,choice});}
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
function writeIncomingPersistentId(doc,row,type,entityId){
  const value=String(entityId||'').trim(),valid=persistentSyncId(type,value);if(!valid||valid!==value)throw Error('Sünkroonitud kirje püsiv ID on vigane.');
  const current=String(getCellVal(doc,type==='Kontroll'?'AA':'S',row)||'').trim(),currentId=persistentSyncId(type,current);
  if(current&&(!currentId||currentId!==value))throw Error('Tööfailis oleva püsiva ID asendamine peatati.');
  writeSyncText(doc,type==='Kontroll'?'AA':'S',row,value);
}
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
  writeIncomingPersistentId(doc,row,'Kontroll',op.entityId);
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
    const oldPrimary=persistentSyncId('Kontroll',old?.kontrollId),knownIds=cycleEntryControlIds(old);
    if(!old||oldPrimary===op.entityId||(!oldPrimary&&!knownIds.length&&old.fingerprint===fp))TC.cycle.entries[values.cabinetId]={...(old||{}),row,fingerprint:fp,kontrollId:op.entityId,defectRows:old?.defectRows||[],note:values.note||old?.note||''};
    else if(!oldPrimary){const additional=new Set(old.additionalKontrollIds||[]);additional.add(op.entityId);TC.cycle.entries[values.cabinetId]={...old,kontrollId:op.entityId,additionalKontrollIds:[...additional].filter(id=>id!==op.entityId),row,fingerprint:fp};}
    else if(!knownIds.includes(op.entityId)){const additional=new Set([...(old.additionalKontrollIds||[]),op.entityId]);TC.cycle.entries[values.cabinetId]={...old,additionalKontrollIds:[...additional]};}
  }
}
async function writeIncomingDefect(op,fields,values){
  const doc=await loadDoc('Puudused'),existingRow=findIncomingRow('Puudus',op.entityId),row=existingRow||firstEmptyRow(doc,'B',5,Math.max(10000,...qsa(doc,'row').map(x=>Number(x.getAttribute('r'))))+1);
  const legacyUnresolved=!!(existingRow&&!String(getCellVal(doc,'S',row)||'').trim()&&String(getCellVal(doc,'U',row)||'').trim().toUpperCase()==='UNRESOLVED');
  if(!legacyUnresolved)writeIncomingPersistentId(doc,row,'Puudus',op.entityId);
  const textFields={cabinetId:'B',inspector:'E',point:'F',description:'G',priority:'H',repeat:'I',owner:'J',repairer:'L',repairAction:'O',lastCheckedBy:'P'};
  for(const [field,col] of Object.entries(textFields))if(Object.hasOwn(fields,field))writeSyncText(doc,col,row,fields[field]);
  for(const [field,col] of [['cabinetTitle','C'],['location','D']])if(Object.hasOwn(fields,field)&&!isFormulaCell(getCell(doc,col+row)))writeSyncText(doc,col,row,fields[field]);
  if(Object.hasOwn(fields,'date'))writeSyncDate(doc,'A',row,fields.date);
  if(Object.hasOwn(fields,'due'))writeSyncDate(doc,'K',row,fields.due);
  if(!legacyUnresolved&&Object.hasOwn(fields,'kontrollId')){
    const linked=String(fields.kontrollId||'').trim();if(linked&&persistentSyncId('Kontroll',linked)!==linked)throw Error('Sünkroonitud puuduse KontrollID on vigane.');
    writeSyncText(doc,'T',row,linked);
    if(!existingRow&&linked){writeSyncText(doc,'U',row,'DIRECT');writeSyncText(doc,'V',row,'ANDROID CREATE');}
  }
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
async function applySyncOperations(operations,senderDeviceId='',directConflictChoices=null){
  if(!Array.isArray(operations))throw Error('Sünkroonimispaketis puudub muudatuste loend.');
  const report={applied:0,duplicates:0,conflicts:0};
  const ok=await transaction(async()=>{
    TC.pendingSemanticRows={Kontroll:{},Puudus:{}};
    for(const op of operations){
      const plan=planSyncOperation(op);if(plan.duplicate){report.duplicates++;continue;}
      await applySyncOperationToWorkbook(op,plan);commitSyncOperation(op,plan);report.applied++;report.conflicts+=plan.conflicts.length;
    }
    if(directConflictChoices){
      for(const [conflictId,choice] of Object.entries(directConflictChoices)){
        const conflict=TC.sync.conflicts.find(c=>c.conflictId===conflictId&&!c.resolved);if(!conflict)continue;
        const entity=TC.sync.entities[conflict.entityType]?.[conflict.entityId];if(!entity)throw Error('Vastuolu kirje puudub. Sünkroonimist ei salvestatud.');
        if(choice==='remote'){
          entity.fieldVersions[conflict.field]=conflict.opId;
          await applySyncOperationToWorkbook({entityType:conflict.entityType,entityId:conflict.entityId,action:'UPDATE_'+conflict.entityType.toUpperCase()}, {applyFields:{[conflict.field]:conflict.remoteValue}});
          entity.values[conflict.field]=conflict.remoteValue;
        }else if(choice==='local'){
          entity.fieldVersions[conflict.field]=conflict.opId;entity.values[conflict.field]=conflict.localValue;
        }else throw Error('Vastuolu otsus on vigane. Sünkroonimist ei salvestatud.');
        appendConflictResolutionOperation(conflict,choice);
        if(!resolveSyncConflictMetadata(conflictId,choice))throw Error('Vastuolu lahendust ei saanud kinnitada. Sünkroonimist ei salvestatud.');
      }
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
  await ensureSyncState();await reconcileKontrollSignatureVersions();TC.revision++;TC.updatedAt=new Date().toISOString();await writeMetadata();await forceRecalc();
  const bytes=await S.zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
  TC.localUsedAt=new Date().toISOString();
  const snapshot={schema:1,dbId:TC.dbId,fileName:S.fileName,registryKey:TC.registryKey,registryTokens:TC.registryTokens,cycle:TC.cycle,sync:TC.sync,signatureVersions:normalizeSignatureVersionMap(TC.signatureVersions),guard:TC.guard,revision:TC.revision,updatedAt:TC.updatedAt,lastUsedAt:TC.localUsedAt,sourceHash:TC.sourceHash,baseWorkbookBase64:TC.baseWorkbookBase64,inspector:S.inspector,dirty:S.dirty,workbookHash:await digest(bytes),summary:captureWorkspaceSummary({updatedAt:TC.updatedAt,revision:TC.revision}),workbookBase64:bytesToBase64(bytes)};
  await storeCall('put',snapshot);TC.startupLoaded=true;TC.startupSnapshot=snapshot;return bytes;
}
function comparableCycleStart(cycle){
  const value=String(cycle?.startedAt||'').trim();if(!value)return'';
  const normalized=value.replace(' ','T').replace(/Z$/,'');return normalized.length>=19?normalized.slice(0,19):normalized;
}
function cyclesShareKontroll(cycleA,cycleB){
  for(const [cabinetId,entryA] of Object.entries(cycleA?.entries||{})){
    const entryB=cycleB?.entries?.[cabinetId];if(!entryB)continue;
    const a=new Set(cycleEntryControlIds(entryA));if(cycleEntryControlIds(entryB).some(id=>a.has(id)))return true;
  }
  return false;
}
function cyclesRepresentSameRound(cycleA,cycleB){
  if(!cycleA||!cycleB)return false;
  if(cycleA.id&&cycleB.id&&cycleA.id===cycleB.id)return true;
  const a=comparableCycleStart(cycleA),b=comparableCycleStart(cycleB);
  return (!!a&&a===b)||cyclesShareKontroll(cycleA,cycleB);
}
function mergeCycleEntry(localEntry,incomingEntry){
  if(!localEntry)return cloneData(incomingEntry);
  if(!incomingEntry)return cloneData(localEntry);
  const merged={...cloneData(incomingEntry),...cloneData(localEntry)};
  const localPrimary=persistentSyncId('Kontroll',localEntry.kontrollId),incomingPrimary=persistentSyncId('Kontroll',incomingEntry.kontrollId),primary=localPrimary||incomingPrimary;
  if(primary)merged.kontrollId=primary;else delete merged.kontrollId;
  const additional=new Set([...cycleEntryControlIds(localEntry),...cycleEntryControlIds(incomingEntry)]);additional.delete(primary);
  if(incomingPrimary&&incomingPrimary!==primary)additional.add(incomingPrimary);
  if(additional.size)merged.additionalKontrollIds=[...additional];else delete merged.additionalKontrollIds;
  const previous={};
  for(const source of [incomingEntry.previousControlDefects||{},localEntry.previousControlDefects||{}])for(const [controlId,rows] of Object.entries(source))previous[controlId]=[...new Set([...(previous[controlId]||[]),...(Array.isArray(rows)?rows:[])])];
  if(Object.keys(previous).length)merged.previousControlDefects=previous;else delete merged.previousControlDefects;
  merged.defectRows=[...new Set([...(incomingEntry.defectRows||[]),...(localEntry.defectRows||[])])];
  if(localEntry.note)merged.note=localEntry.note;else if(incomingEntry.note)merged.note=incomingEntry.note;
  return merged;
}
function mergeCurrentCycle(localCycle,incomingCycle){
  if(!localCycle)return incomingCycle?cloneData(incomingCycle):null;
  if(!incomingCycle)return cloneData(localCycle);
  // A local unfinished cycle is the phone's active work. Merge a peer/export cycle only
  // when shared cycle identity, start time, or permanent inspection IDs prove relation.
  if(!cyclesRepresentSameRound(localCycle,incomingCycle))return cloneData(localCycle);
  const entries={};
  for(const cabinetId of new Set([...Object.keys(localCycle.entries||{}),...Object.keys(incomingCycle.entries||{})]))
    entries[cabinetId]=mergeCycleEntry(localCycle.entries?.[cabinetId],incomingCycle.entries?.[cabinetId]);
  return {...cloneData(incomingCycle),...cloneData(localCycle),id:localCycle.id||incomingCycle.id,startedAt:localCycle.startedAt||incomingCycle.startedAt,entries};
}
async function transaction(change,options={}){
  if(TC.busy||TC.exportPending)return false;setBusy(true);
  const rowIds={Kontroll:Object.fromEntries(TC.records.map(r=>[String(r.row),r.syncId]).filter(([,id])=>id)),Puudus:Object.fromEntries(TC.allDefects.map(d=>[String(d.row),d.syncId]).filter(([,id])=>id))};
  const before={zip:cloneWorkbook(S.zip),tc:cloneData({cycle:TC.cycle,guard:TC.guard,revision:TC.revision,updatedAt:TC.updatedAt,sync:TC.sync,signatureVersions:TC.signatureVersions}),semantic:semanticState(),inspector:S.inspector,dirty:S.dirty};
  let committed=false;
  try{TC.pendingSyncRowIds=rowIds;await change();await refreshFromWorkbook();if(!options.skipSemanticJournal)await appendSemanticOperations(before.semantic);await persistWorkspace();committed=true;renderCyclePanel();return true;}
  catch(e){if(committed){alert('Andmed on telefonis salvestatud, kuid vaadet ei saanud uuendada. Ava tööfail uuesti.\n'+e.message);return true;}S.zip=before.zip;Object.assign(TC,before.tc);TC.pendingSyncRowIds=null;TC.pendingSemanticRows=null;S.inspector=before.inspector;S.dirty=before.dirty;await refreshFromWorkbook();alert(`${options.rollbackMessage||'Andmeid EI salvestatud. Proovi uuesti.'}\n${e.message}`);return false;}
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
async function importXlsx(ev,sourceBytes=null){
  if(TC.startupTask)await TC.startupTask;
  const file=ev.target.files?.[0];if(!file||TC.busy)return;
  const old={zip:S.zip,fileName:S.fileName,tc:cloneData({...TC,opened:null,pending:null}),inspector:S.inspector,dirty:S.dirty};
  setBusy(true);stopInspectionTimer();
  try{
    const bytes=sourceBytes?new Uint8Array(sourceBytes):new Uint8Array(await file.arrayBuffer());TC.cycle=null;TC.ready=false;await loadBook(bytes,file.name);
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
        Object.assign(TC,{dbId:local.dbId,registryKey:local.registryKey||identity.key,registryTokens:local.registryTokens||identity.tokens,cycle:local.cycle||null,sync:local.sync||null,signatureVersions:normalizeSignatureVersionMap(local.signatureVersions||embedded?.signatureVersions),guard:local.guard||{remaining:randomGap(),pending:null},revision:Number(local.revision)||0,updatedAt:local.updatedAt||null,sourceHash:local.sourceHash||'',baseWorkbookBase64:local.baseWorkbookBase64||''});
        S.inspector=local.inspector||'';S.dirty=!!local.dirty;notice='Jätkatakse telefonis salvestatud tööfailiga. Valitud välist faili ei muudetud.';
      }else{
        let importedZip=S.zip,cycle=embedded?.cycle||null;
        if(choice==='merge'){
          try{importedZip=await mergeLocalIntoIncoming(local,S.zip);merged=true;notice='Tööfailid ühendati. Telefonis olnud muudatused säilitati ja algfaili ei muudetud.';}
          catch(e){
            const recovery=await showAppChoice('Turvalist ühendamist ei saanud teha',`Telefonis olev töö ei ole muutunud.<br>${esc(e.message)}<br><br>Vali, kas jätkata telefonis salvestatud tööga või teadlikult kasutada valitud faili.`,[{value:'internal',label:'JÄTKA TELEFONI TÖÖGA',primary:true},{value:'replace',label:'KASUTA VALITUD FAILI JA ASENDA TELEFONI KOOPIA'},{value:'cancel',label:'TÜHISTA'}]);
            if(recovery==='cancel'||!recovery)throw Error('Ühendamine tühistati. Telefonis salvestatud töö jäi alles.');
            if(recovery==='internal'){selectedInternal=true;chosenBytes=decode64(local.workbookBase64);chosenName=local.fileName||file.name;Object.assign(TC,{dbId:local.dbId,registryKey:local.registryKey||identity.key,registryTokens:local.registryTokens||identity.tokens,cycle:local.cycle||null,sync:local.sync||null,signatureVersions:normalizeSignatureVersionMap(local.signatureVersions||embedded?.signatureVersions),guard:local.guard||{remaining:randomGap(),pending:null},revision:Number(local.revision)||0,updatedAt:local.updatedAt||null,sourceHash:local.sourceHash||'',baseWorkbookBase64:local.baseWorkbookBase64||''});S.inspector=local.inspector||'';S.dirty=!!local.dirty;notice='Telefonis salvestatud töö taastati; ühendamine ebaõnnestus.';}
            else{cycle=embedded?.cycle||null;notice='Valitud fail kasutati sinu kinnitusega; telefoni eelmist koopiat ei kirjutatud tagasi.';}
          }
        }
        if(!selectedInternal){
          const mergedCycle=merged?mergeCurrentCycle(local.cycle,cycle):cycle;
          chosenBytes=await importedZip.generateAsync({type:'uint8array'});chosenName=file.name;
          Object.assign(TC,{dbId:embedded?.dbId||local.dbId,registryKey:identity.key,registryTokens:identity.tokens,cycle:mergedCycle,sync:local.sync||embedded?.sync||null,signatureVersions:mergeSignatureVersionMaps(local.signatureVersions,embedded?.signatureVersions),guard:local.guard||{remaining:randomGap(),pending:null},revision:Math.max(Number(local.revision)||0,Number(embedded?.revision)||0),updatedAt:embedded?.updatedAt||local.updatedAt||null,sourceHash:await digest(bytes),baseWorkbookBase64:bytesToBase64(bytes)});
          S.inspector=embedded?.inspector||local.inspector||'';S.dirty=merged||!!local.dirty;
        }
      }
    }else{
      Object.assign(TC,{dbId:embedded?.dbId||uid(),registryKey:identity.key,registryTokens:identity.tokens,cycle:embedded?.cycle||null,sync:embedded?.sync||null,signatureVersions:normalizeSignatureVersionMap(embedded?.signatureVersions),guard:{remaining:randomGap(),pending:null},revision:embedded?.revision||0,updatedAt:embedded?.updatedAt||null,sourceHash:await digest(bytes),baseWorkbookBase64:bytesToBase64(bytes)});S.inspector=embedded?.inspector||'';S.dirty=false;
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
  const ordered=[...records].sort((a,b)=>a.date.localeCompare(b.date)||(realStartFromRecord(a)||'').localeCompare(realStartFromRecord(b)||'')||a.row-b.row);
  const rowsForControl=r=>TC.allDefects.filter(d=>d.id===r.id&&(r.syncId&&d.kontrollId===r.syncId||!d.kontrollId&&d.date===r.date&&d.inspector===r.inspector)).map(d=>d.row);
  for(const r of ordered){
    const controlId=persistentSyncId('Kontroll',r.syncId||r.persistentId),defectRows=rowsForControl(r),old=cycle.entries[r.id];
    if(!old){cycle.entries[r.id]={row:r.row,fingerprint:recordFingerprint(r),...(controlId?{kontrollId:controlId}:{}),defectRows,note:''};continue;}
    const previousControlDefects={...(old.previousControlDefects||{})},oldPrimary=persistentSyncId('Kontroll',old.kontrollId);
    if(oldPrimary&&oldPrimary!==controlId&&old.defectRows?.length)previousControlDefects[oldPrimary]=[...new Set([...(previousControlDefects[oldPrimary]||[]),...old.defectRows])];
    const additional=new Set([...(old.additionalKontrollIds||[]),...(oldPrimary&&oldPrimary!==controlId?[oldPrimary]:[])]);if(controlId)additional.delete(controlId);
    cycle.entries[r.id]={...old,row:r.row,fingerprint:recordFingerprint(r),...(controlId?{kontrollId:controlId}:{}),defectRows,...(additional.size?{additionalKontrollIds:[...additional]}:{}),...(Object.keys(previousControlDefects).length?{previousControlDefects}:{})};
  }
  return cycle;
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
  const ready=!!(S.zip&&TC.dbId&&TC.sync),baseline=$('syncBaselineBtn'),send=$('syncSendBtn'),receive=$('syncReceiveBtn'),status=$('syncLocalStatus'),showQr=$('lanShowQrBtn'),scanQr=$('lanScanQrBtn');
  if(baseline)baseline.disabled=!ready;if(send)send.disabled=!ready||!(TC.sync?.journal||[]).length;if(receive)receive.disabled=!ready;
  const directAvailable=!!(window.Android&&typeof Android.startLanSyncSession==='function'&&typeof Android.startLanSyncClient==='function'&&typeof Android.createLanSyncQrPngBase64==='function'&&typeof Android.scanQr==='function');
  if(showQr)showQr.disabled=!ready||!directAvailable;if(scanQr)scanQr.disabled=!directAvailable;
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
async function savedKontrollSignatureStatus(record){
  const recordId=persistentSyncId('Kontroll',record?.persistentId||record?.syncId);if(!recordId||!S.paths.Allkirjad)return 'Allkiri puudub';
  try{
    await reconcileKontrollSignatureVersions();
    const controlDoc=await loadDoc('Kontrollid'),controlRows=qsa(controlDoc,'row').filter(row=>getCellVal(controlDoc,'AA',Number(row.getAttribute('r')) )===recordId);
    if(controlRows.length!==1)return 'Allkirja sihtkirje on ebaselge';
    const pointer=getCellVal(controlDoc,'AB',Number(controlRows[0].getAttribute('r')));if(!pointer)return 'Allkiri puudub';
    const signatureDoc=await loadDoc('Allkirjad'),rows=s2SignatureRowsById(signatureDoc,pointer);if(rows.length!==1)return 'Allkirja kirje puudub või kordub';
    const row=rows[0],stored=s2CellString(signatureDoc,'F',row),current=TC.signatureVersions?.[recordId],version=Number(s2CellString(signatureDoc,'I',row));
    if(stored==='Tühistatud'||(current&&current.recordVersion!==version))return 'Tühistatud';
    if(stored==='Kehtiv'&&s2CellString(signatureDoc,'C',row)===recordId&&s2CellString(signatureDoc,'B',row)==='Kontroll')return 'Kehtiv (kohalikult kontrollitud)';
    return stored||'Allkirja olek puudub';
  }catch(e){return 'Allkirja olekut ei saanud kontrollida';}
}
async function viewSavedInspection(id,record,entry){
  const ratings=CHECKS.map(([col,label])=>{const value=record.ratings?.[col]??'',shown=value===''?'–':String(value);return `${esc(label)}: <b>${esc(shown)} — ${esc(scoreLabel(value))}</b>`;}).join('<br>');
  const linkedRows=new Set(entry?.defectRows||[]),defects=TC.allDefects.filter(d=>d.id===id&&(linkedRows.has(d.row)||TC.sync?.entities?.Puudus?.[d.syncId]?.values?.kontrollId===record.syncId));
  const defectHtml=defects.length?defects.map(d=>`• ${esc(d.point||'Puudus')}: ${esc(d.desc||'')} — ${esc(d.closed?'Kõrvaldatud':'Avatud')}`).join('<br>'):'Puuduseid pole seotud';
  const signatureStatus=await savedKontrollSignatureStatus(record);
  const choice=await showAppChoice('VAATA KONTROLLI',`<b>${esc(id)} • ${esc(cabinetTitle(S.selected))}</b><br>Kontrollitud: ${esc(inspectionStamp(record))}<br>Kontrollija: ${esc(record.inspector||'—')}<br>Allkiri: <b>${esc(signatureStatus)}</b><div class="topgap">${ratings}</div><div class="topgap"><b>Puudused (${defects.length})</b><br>${defectHtml}</div>`,[{value:'signature',label:'ALLKIRJA MUSTAND'},{value:'back',label:'TAGASI',primary:true}]);
  if(choice==='signature')return startKontrollSignatureDraft(record);
}
const KONTROLL_VERSION_SOURCE='KONTROLL_SNAPSHOT_METADATA_V1';
const KONTROLL_VERSION_FORMAT='dold-kontroll-record-version/v1';
const SIGNATURE_SNAPSHOT_FIELDS={Kontroll:[['A','U'],['B','V'],['D','W'],['H','X'],['I','Y'],['J','Z'],['K','AA'],['L','AB'],['M','AC'],['N','AD'],['O','AE'],['P','AF'],['Q','AG'],['R','AH'],['W','AI'],['X','AJ'],['Y','AK'],['Z','AL']],Parandus:[['B','AM'],['C','AN'],['D','AO'],['E','AP'],['F','AQ'],['G','AR'],['H','AS'],['L','AT'],['M','AU'],['N','AV'],['O','AW']]};
function normalizeSignatureVersionMap(value){
  const out={};if(!value||typeof value!=='object'||Array.isArray(value))return out;
  for(const [id,item] of Object.entries(value)){
    if(!persistentSyncId('Kontroll',id)||!item||typeof item!=='object')continue;
    const recordVersion=Number(item.recordVersion),snapshotHash=String(item.snapshotHash||'');
    if(Number.isSafeInteger(recordVersion)&&recordVersion>=1&&/^[a-f0-9]{64}$/.test(snapshotHash))out[id]={recordVersion,snapshotHash,source:KONTROLL_VERSION_SOURCE};
  }
  return out;
}
function mergeSignatureVersionMaps(local,incoming){return {...normalizeSignatureVersionMap(incoming),...normalizeSignatureVersionMap(local)};}
function signatureCanonicalJson(value){
  if(value===null)return 'null';
  if(typeof value==='string'){
    for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){if(i+1>=value.length||value.charCodeAt(i+1)<0xdc00||value.charCodeAt(i+1)>0xdfff)throw Error('Sõltuvusväli sisaldab vigast Unicode’i.');i++;}else if(c>=0xdc00&&c<=0xdfff)throw Error('Sõltuvusväli sisaldab vigast Unicode’i.');}
    return JSON.stringify(value);
  }
  if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Sõltuvusväli sisaldab vigast arvu.');return JSON.stringify(value);}
  if(typeof value==='boolean')return value?'true':'false';
  if(Array.isArray(value))return '['+value.map(signatureCanonicalJson).join(',')+']';
  if(typeof value==='object')return '{'+Object.keys(value).sort().map(k=>signatureCanonicalJson(k)+':'+signatureCanonicalJson(value[k])).join(',')+'}';
  throw Error('Sõltuvusvälja tüüpi ei toetata.');
}
function signatureTypedCellValue(doc,col,row){
  const cell=getCell(doc,col+row);if(!cell)return {type:'blank'};
  if(qsa(cell,'f').length)return null;
  const t=cell.getAttribute('t')||'n';
  if(t==='s'||t==='inlineStr'||t==='str')return {type:'string',value:cellValue(cell)};
  if(t==='b')return {type:'boolean',value:getV(cell)==='1'};
  if(t==='e')return null;
  if(t==='d')return {type:'date',value:getV(cell)};
  const raw=getV(cell);if(raw==='')return {type:'blank'};
  const number=Number(raw);return Number.isFinite(number)?{type:'number',value:number}:null;
}
function kontrollVersionSnapshot(doc,row,kontrollId){
  const fields={kontrollId:signatureTypedCellValue(doc,'AA',row),kilpId:signatureTypedCellValue(doc,'B',row),inspectionDate:signatureTypedCellValue(doc,'A',row),inspector:signatureTypedCellValue(doc,'D',row),scores:{}};
  for(const col of ['H','I','J','K','L','M','N','O','P','Q','R'])fields.scores[col]=signatureTypedCellValue(doc,col,row);
  fields.start=signatureTypedCellValue(doc,'W',row);fields.end=signatureTypedCellValue(doc,'X',row);fields.duration=signatureTypedCellValue(doc,'Y',row);fields.exceptionReason=signatureTypedCellValue(doc,'Z',row);
  if(Object.values(fields).some(v=>v===null)||Object.values(fields.scores).some(v=>v===null))return null;
  if(fields.kontrollId.type!=='string'||fields.kontrollId.value!==kontrollId||fields.kilpId.type!=='string'||!fields.kilpId.value||fields.inspector.type!=='string'||!fields.inspector.value)return null;
  return {format:KONTROLL_VERSION_FORMAT,fields};
}
async function reconcileKontrollSignatureVersions(){
  TC.signatureVersions=normalizeSignatureVersionMap(TC.signatureVersions);
  if(!S.zip||!S.paths.Kontrollid)return TC.signatureVersions;
  const doc=await loadDoc('Kontrollid'),rows=new Map();
  for(const rowEl of qsa(doc,'row')){
    const row=Number(rowEl.getAttribute('r'));if(row<5)continue;
    const id=persistentSyncId('Kontroll',getCellVal(doc,'AA',row));if(!id)continue;
    const list=rows.get(id)||[];list.push(row);rows.set(id,list);
  }
  for(const [id,matches] of rows){
    if(matches.length!==1)continue;
    const snapshot=kontrollVersionSnapshot(doc,matches[0],id);if(!snapshot)continue;
    const snapshotHash=await digest(new TextEncoder().encode(signatureCanonicalJson(snapshot))),prior=TC.signatureVersions[id];
    if(prior?.snapshotHash===snapshotHash)continue;
    const recordVersion=prior?Number(prior.recordVersion)+1:1;if(!Number.isSafeInteger(recordVersion)||recordVersion<1)continue;
    TC.signatureVersions[id]={recordVersion,snapshotHash,source:KONTROLL_VERSION_SOURCE};
  }
  return TC.signatureVersions;
}
async function draftKontrollRecordVersion(record){
  const id=persistentSyncId('Kontroll',record?.persistentId||record?.syncId);
  if(!id||!S.zip||!S.paths.Kontrollid)return {recordVersion:null,recordVersionSource:'UNRESOLVED',recordVersionSnapshotHash:''};
  const doc=await loadDoc('Kontrollid'),rows=qsa(doc,'row').filter(x=>persistentSyncId('Kontroll',getCellVal(doc,'AA',Number(x.getAttribute('r'))))===id);
  // Permanent KontrollID is identity. The hydrated row is only a cache hint and may be stale after import/reorder.
  if(rows.length!==1)return {recordVersion:null,recordVersionSource:'UNRESOLVED',recordVersionSnapshotHash:''};
  const row=Number(rows[0].getAttribute('r'));
  if(getCellVal(doc,'B',row).trim()!==String(record.id||'').trim())return {recordVersion:null,recordVersionSource:'UNRESOLVED',recordVersionSnapshotHash:''};
  if(!kontrollVersionSnapshot(doc,row,id))return {recordVersion:null,recordVersionSource:'UNRESOLVED',recordVersionSnapshotHash:''};
  const versions=await reconcileKontrollSignatureVersions(),entry=versions[id];
  if(!entry||entry.source!==KONTROLL_VERSION_SOURCE)return {recordVersion:null,recordVersionSource:'UNRESOLVED',recordVersionSnapshotHash:''};
  return {recordVersion:entry.recordVersion,recordVersionSource:KONTROLL_VERSION_SOURCE,recordVersionSnapshotHash:entry.snapshotHash};
}
function signatureTargetFormula(targetType,row){
  if(!Number.isInteger(row)||row<5||row>500)throw Error('Allkirja valemi rida peab olema vahemikus 5:500.');
  const sheet=targetType==='Kontroll'?'Kontrollid':targetType==='Parandus'?'Parandused':'';if(!sheet)throw Error('Tundmatu allkirja sihttüüp.');
  const col=targetType==='Kontroll'?'AA':'A',id=`$C${row}`,range=`${sheet}!$${col}$5:$${col}$500`;
  return `=IFERROR(IF(COUNTIF(${range},${id})=1,MATCH(${id},${range},0),\"\"),\"\")`;
}
function signatureTypedMatchFormula(targetRef,snapshotRef){
  return `AND(ISBLANK(${targetRef})=ISBLANK(${snapshotRef}),IF(ISBLANK(${targetRef}),TRUE,AND(TYPE(${targetRef})=TYPE(${snapshotRef}),IF(TYPE(${targetRef})=2,EXACT(${targetRef},${snapshotRef}),${targetRef}=${snapshotRef}))))`;
}
function signatureEffectiveStatusFormula(targetType,row){
  if(!Number.isInteger(row)||row<5||row>500)throw Error('Allkirja valemi rida peab olema vahemikus 5:500.');
  const sheet=targetType==='Kontroll'?'Kontrollid':targetType==='Parandus'?'Parandused':'';if(!sheet)throw Error('Tundmatu allkirja sihttüüp.');
  const checks=SIGNATURE_SNAPSHOT_FIELDS[targetType].map(([sourceCol,snapshotCol])=>signatureTypedMatchFormula(`INDEX(${sheet}!$${sourceCol}$5:$${sourceCol}$500,$T${row})`,`$${snapshotCol}${row}`));
  return `=IFERROR(IF($F${row}=\"Tühistatud\",\"Tühistatud\",IF(OR($T${row}=\"\",NOT(ISNUMBER($T${row}))),\"Tühistatud\",IF(AND($F${row}=\"Kehtiv\",${checks.join(',')}),\"Kehtiv\",\"Tühistatud\"))),\"Tühistatud\")`;
}
const S2_SIGNATURE_FORMATS=Object.freeze({record:'dold-kontroll/v2',strokes:'dold-strokes/v1',proof:'dold-signature-proof/v1',geometry:'dold-geometry/v1'});
const S2_SIGNATURE_RENDERER='dold-signature-normalized-png-v1;900x300;transparent-rgba;black-opaque;stroke-9px;round-cap;round-join;pad-8pct;map-normalized-x-y;crop-none;png-filter-none-deflate-6-no-metadata';
const S2_SIGNATURE_NS=Object.freeze({main:'http://schemas.openxmlformats.org/spreadsheetml/2006/main',pkg:'http://schemas.openxmlformats.org/package/2006/relationships',rel:'http://schemas.openxmlformats.org/officeDocument/2006/relationships',richRel:'http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel',rich:'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata',richExt:'{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}'});
function s2SignatureBlock(code,message){const e=new Error(`${code}: ${message}`);e.signatureCode=code;return e;}
function s2RequireSignatureStructure(){
  for(const name of ['Kontrollid','Allkirjad','Allkirja_jaljed','Allkirjade pildid'])if(!S.paths[name]||!S.zip?.file(S.paths[name]))throw s2SignatureBlock('SIGNATURE_STRUCTURE_UNSUPPORTED',`Tööfail ei sisalda kinnitatud allkirjalehte „${name}”. Mustand jäi telefoni.`);
  for(const part of ['xl/workbook.xml','xl/metadata.xml','xl/richData/rdrichvalue.xml','xl/richData/richValueRel.xml','xl/richData/_rels/richValueRel.xml.rels','[Content_Types].xml'])if(!S.zip.file(part))throw s2SignatureBlock('SIGNATURE_STRUCTURE_UNSUPPORTED',`Tööfailist puudub allkirjastamise vajalik OOXML osa: ${part}. Mustand jäi telefoni.`);
}
async function s2ParsePart(zip,path){
  const file=zip?.file(path);if(!file)throw s2SignatureBlock('OOXML_INVALID',`Töövihiku osa puudub: ${path}`);
  const doc=parseXml(await file.async('string'));if(!doc?.documentElement||doc.documentElement.localName==='parsererror'||qsa(doc,'parsererror').length)throw s2SignatureBlock('OOXML_INVALID',`XML-i ei saa lugeda: ${path}`);return doc;
}
function s2CellString(doc,col,row){const value=getCellVal(doc,col,row);return value==null?'':String(value);}
function s2Rows(doc,min=5,max=500){return qsa(doc,'row').map(x=>Number(x.getAttribute('r'))).filter(n=>Number.isInteger(n)&&n>=min&&n<=max);}
function s2SignatureRowsById(doc,id){return s2Rows(doc,5,500).filter(row=>s2CellString(doc,'A',row)===id);}
function s2CellHasValue(cell){return !!cell&&(cell.getAttribute('t')==='e'||isFormulaCell(cell)||String(cellValue(cell)||'')!=='');}
function s2ColumnName(number){let n=number,out='';while(n){const r=(n-1)%26;out=String.fromCharCode(65+r)+out;n=Math.floor((n-1)/26);}return out;}
function s2UpdateDimension(doc,lastColumn,lastRow){
  const dimension=qsa(doc,'dimension')[0];if(!dimension)return;
  const ref=String(dimension.getAttribute('ref')||'A1:A1'),parts=ref.split(':'),start=parts[0]||'A1',end=parts[1]||start;
  const oldCol=(end.match(/[A-Z]+/i)||['A'])[0].toUpperCase(),oldRow=Number((end.match(/\d+/)||['1'])[0])||1;
  const column=colNum(oldCol)>=colNum(lastColumn)?oldCol:lastColumn;
  dimension.setAttribute('ref',`${start}:${column}${Math.max(oldRow,lastRow)}`);
}
function s2SetFormulaCached(doc,col,row,formula,cached,type='number'){
  const cell=ensureCell(doc,col,row);clearCellContent(cell);cell.removeAttribute('t');
  const f=doc.createElementNS(cell.namespaceURI,'f');f.textContent=String(formula||'').replace(/^=/,'');cell.appendChild(f);
  if(type==='string')cell.setAttribute('t','str');else cell.removeAttribute('t');
  const v=doc.createElementNS(cell.namespaceURI,'v');v.textContent=String(cached??'');cell.appendChild(v);
}
function s2SetUtcExcelSerial(doc,col,row,utcMs){
  if(!Number.isSafeInteger(utcMs)||utcMs<0)throw s2SignatureBlock('CLOCK_INCONSISTENT',`UTC aeg on vigane: ${col}${row}`);
  setNum(doc,col,row,utcMs/86400000+25569);
}
function s2TypedScalar(typed){if(!typed)throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED','Kontrolli kaitstud väli sisaldab valemit või vigast väärtust.');return typed.type==='blank'?null:typed.value;}
function s2ExcelDateToUtcMs(typed,name){
  if(!typed)throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED',`Kontrolli ajaväli ${name} ei ole toetatud.`);
  if(typed.type==='blank')return null;
  if(typed.type==='number'){
    const value=Number(typed.value);if(!Number.isFinite(value))throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED',`Kontrolli ajaväli ${name} ei ole arvuline.`);
    const ms=Math.round((value-25569)*86400000);if(!Number.isSafeInteger(ms)||ms<0)throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED',`Kontrolli ajaväli ${name} jääb kinnitatud kuupäevavahemikust välja.`);return ms;
  }
  if((typed.type==='string'||typed.type==='date')&&typeof typed.value==='string'&&/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(typed.value)){
    const ms=Date.parse(typed.value);if(Number.isSafeInteger(ms)&&ms>=0)return ms;
  }
  throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED',`Kontrolli ajaväli ${name} ei ole kinnitatud UTC-kujul.`);
}
function s2InspectionDate(typed){
  if(!typed||typed.type==='blank')throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED','Kontrolli kuupäev puudub.');
  if(typed.type==='number'){
    const value=Number(typed.value);if(!Number.isFinite(value)||value<20000)throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED','Kontrolli kuupäeva Exceli väärtust ei tunta.');
    const ms=Date.UTC(1899,11,30)+Math.floor(value)*86400000;return new Date(ms).toISOString().slice(0,10);
  }
  if((typed.type==='string'||typed.type==='date')&&/^\d{4}-\d{2}-\d{2}$/.test(String(typed.value)))return String(typed.value);
  throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED','Kontrolli kuupäev ei ole kinnitatud kalendripäeva kujul.');
}
function s2DurationMs(typed){
  if(!typed)throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED','Kontrolli kestus sisaldab valemit või vigast väärtust.');
  if(typed.type==='blank')return null;
  if(typed.type!=='number'||!Number.isFinite(Number(typed.value)))throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED','Kontrolli kestus ei ole Exceli arvuline kestus.');
  const ms=Math.round(Number(typed.value)*86400000);if(!Number.isSafeInteger(ms)||ms<0)throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED','Kontrolli kestus jääb lubatud vahemikust välja.');return ms;
}
function s2BuildRecordSnapshot(doc,row,recordId,recordVersion){
  const id=signatureTypedCellValue(doc,'AA',row),kilp=signatureTypedCellValue(doc,'B',row),inspector=signatureTypedCellValue(doc,'D',row);
  if(id?.type!=='string'||id.value!==recordId||kilp?.type!=='string'||!kilp.value||inspector?.type!=='string'||!inspector.value)throw s2SignatureBlock('TARGET_MISMATCH','KontrollID, KilpID või kontrollija ei klapi püsiva kirjega.');
  const scores={};for(const col of ['H','I','J','K','L','M','N','O','P','Q','R']){const typed=signatureTypedCellValue(doc,col,row);if(!typed)throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED',`Kontrolli hinnang ${col} ei ole toetatud.`);if(typed.type==='blank')scores[col]=null;else if(typed.type==='number'&&Number.isInteger(typed.value)&&typed.value>=0&&typed.value<=5)scores[col]=typed.value;else throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED',`Kontrolli hinnang ${col} ei ole arv vahemikus 0–5 ega tühi.`);}
  const exception=signatureTypedCellValue(doc,'Z',row);if(!exception||!(exception.type==='blank'||exception.type==='string'))throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED','Erandi põhjus ei ole toetatud tekstiväli.');
  return {format:S2_SIGNATURE_FORMATS.record,recordId,recordVersion,kilpId:kilp.value,inspectionDate:s2InspectionDate(signatureTypedCellValue(doc,'A',row)),inspectorName:inspector.value,scores,startedAtUtcMs:s2ExcelDateToUtcMs(signatureTypedCellValue(doc,'W',row),'W'),endedAtUtcMs:s2ExcelDateToUtcMs(signatureTypedCellValue(doc,'X',row),'X'),durationMs:s2DurationMs(signatureTypedCellValue(doc,'Y',row)),exceptionReason:s2TypedScalar(exception)};
}
function s2BuildStrokes(draft){
  if(!Array.isArray(draft.points)||!draft.points.length||draft.points.length!==Number(draft.pointCount)||!Number.isSafeInteger(Number(draft.strokeCount))||Number(draft.strokeCount)<1)throw s2SignatureBlock('STROKES_MISSING','Allkirja salvestatud puutepunktid puuduvad või ei klapi.');
  const points=[],geometry=[],seen=new Set();let stroke=1,point=1,lastElapsed=-1;
  for(const raw of draft.points){
    const tuple=Array.isArray(raw)?raw:[raw?.strokeNr,raw?.pointNr,raw?.xNorm,raw?.yNorm,raw?.elapsedMs];
    if(tuple.length!==5||tuple.some(x=>!Number.isSafeInteger(Number(x))))throw s2SignatureBlock('STROKES_INVALID','Allkirja puutepunkti väärtus ei ole täisarv.');
    const [s,p,x,y,elapsed]=tuple.map(Number);
    if(s!==stroke||p!==point||x<0||x>1000000||y<0||y>1000000||elapsed<lastElapsed||elapsed<0||elapsed>Number(draft.captureDurationMs))throw s2SignatureBlock('STROKES_INVALID','Allkirja punktide järjekord või väärtus ei klapi.');
    points.push([s,p,x,y,elapsed]);geometry.push([s,p,x,y]);seen.add(`${x}:${y}`);lastElapsed=elapsed;
    const next=draft.points[points.length];if(next){const nextStroke=Number(Array.isArray(next)?next[0]:next.strokeNr);if(nextStroke!==stroke){if(nextStroke!==stroke+1)throw s2SignatureBlock('STROKES_INVALID','Allkirja joonte järjekorras on katkestus.');stroke++;point=1;}else point++;}
  }
  if(stroke!==Number(draft.strokeCount)||seen.size<2)throw s2SignatureBlock('STROKES_INVALID','Allkirja joonte arv või geomeetria ei klapi.');
  return {strokes:{format:S2_SIGNATURE_FORMATS.strokes,canvasWidthPx:Number(draft.canvasWidthPx),canvasHeightPx:Number(draft.canvasHeightPx),points},geometry:{format:S2_SIGNATURE_FORMATS.geometry,points:geometry}};
}
function s2PngDimensions(png){
  if(!(png instanceof Uint8Array)||png.length<33||png[0]!==137||png[1]!==80||png[2]!==78||png[3]!==71||png[4]!==13||png[5]!==10||png[6]!==26||png[7]!==10)throw s2SignatureBlock('PNG_INVALID','Allkirja PNG ei ole täielik PNG-fail.');
  const u32=o=>((png[o]*0x1000000)+(png[o+1]*0x10000)+(png[o+2]*0x100)+png[o+3])>>>0;
  return {width:u32(16),height:u32(20)};
}
async function s2ValidateDraft(draft){
  if(!draft||draft.schemaVersion!==1||draft.status!=='S1_DRAFT'||draft.targetType!=='Kontroll')throw s2SignatureBlock('PROOF_INCOMPLETE','Tootmiskinnituseks on lubatud ainult täielik Kontrolli kohalik mustand.');
  if(!/^dtc-sign-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(draft.signatureId||'')))throw s2SignatureBlock('PROOF_INCOMPLETE','AllkiriID ei ole UUIDv4 kujul.');
  if(!persistentSyncId('Kontroll',draft.recordId)||draft.recordId!==persistentSyncId('Kontroll',draft.recordId))throw s2SignatureBlock('UNRESOLVED_TARGET','Kontrollil puudub püsiv KontrollID.');
  if(!/^device-[a-f0-9]{32}$/.test(String(draft.deviceInstanceId||''))||!String(draft.signerName||'').trim()||draft.inputMethod!=='TOUCH'||draft.clockSource!=='DEVICE_WALL_CLOCK_UNTRUSTED'||draft.rendererProfile!==S2_SIGNATURE_RENDERER)throw s2SignatureBlock('PROOF_INCOMPLETE','Allkirja capture metaandmed ei vasta kinnitatud S1.5 profiilile.');
  if(typeof draft.appVersionName!=='string'||!draft.appVersionName.trim()||draft.appVersionName.length>64||!Number.isSafeInteger(Number(draft.appVersionCode))||Number(draft.appVersionCode)<1||typeof draft.androidRelease!=='string'||!draft.androidRelease.trim()||draft.androidRelease.length>64||!Number.isSafeInteger(Number(draft.androidApiLevel))||Number(draft.androidApiLevel)<1)throw s2SignatureBlock('PROOF_INCOMPLETE','Allkirja rakenduse või Androidi versiooniandmed puuduvad või on vigased.');
  if(!Number.isSafeInteger(Number(draft.recordVersion))||Number(draft.recordVersion)<1||draft.recordVersionSource!==KONTROLL_VERSION_SOURCE)throw s2SignatureBlock('RECORD_VERSION_UNKNOWN','Kontrolli püsiv kirjeversioon puudub või pole toetatud.');
  const metadata=draft.targetMetadata||{};if(!metadata.workbookIdentity||metadata.workbookIdentity!==String(TC.dbId||''))throw s2SignatureBlock('WRONG_DATABASE','Allkirja mustand kuulub teise või tundmatu tööandmebaasi juurde.');
  if(!/^[0-9a-f]{64}$/.test(String(draft.nonce||''))||!/^\d{4}-\d{2}-\d{2}$/.test(String(metadata.inspectionDate||''))||String(metadata.inspectorName||'')!==String(draft.signerName))throw s2SignatureBlock('PROOF_INCOMPLETE','Allkirja sihtmetaandmed ei klapi Kontrolli hetktõmmisega.');
  const start=Number(draft.captureStartedAtUtcMs),end=Number(draft.captureEndedAtUtcMs),duration=Number(draft.captureDurationMs);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||!Number.isSafeInteger(duration)||start<0||end<=start||duration<=0||Math.abs((end-start)-duration)>5000)throw s2SignatureBlock('CLOCK_INCONSISTENT','Seadme kella ja monotoonse allkirja kestuse erinevus on liiga suur.');
  if(!draft.antiReuse||draft.antiReuse.algorithm!=='dold-exact-reuse/v1'||draft.antiReuse.scope!=='LOCAL_KNOWN_DATA'||draft.antiReuse.result!=='UNIQUE'||!Number.isSafeInteger(Number(draft.antiReuse.checkedAtUtcMs))||Number(draft.antiReuse.checkedAtUtcMs)<=0||!Number.isSafeInteger(Number(draft.antiReuse.checkedCount))||Number(draft.antiReuse.checkedCount)<0||!/^[0-9a-f]{64}$/.test(String(draft.antiReuse.registryDigest||''))||(draft.antiReuse.matchingSignatureIds||[]).length)throw s2SignatureBlock('REUSE_NOT_CHECKED','Kohaliku korduskasutuse kontroll ei kinnitanud allkirja. Mustand jäi telefoni.');
  const canvasWidthPx=draft.canvasWidthPx,canvasHeightPx=draft.canvasHeightPx;
  if(!Number.isSafeInteger(canvasWidthPx)||!Number.isSafeInteger(canvasHeightPx)||canvasWidthPx<2||canvasHeightPx<2||canvasWidthPx*canvasHeightPx>4000000)throw s2SignatureBlock('STROKES_INVALID','Allkirja native canvas mõõtmed on vigased.');
  const {strokes,geometry}=s2BuildStrokes(draft),strokeHash=await digest(new TextEncoder().encode(signatureCanonicalJson(strokes))),geometryHash=await digest(new TextEncoder().encode(signatureCanonicalJson(geometry)));
  if(strokeHash!==draft.strokeHash||geometryHash!==draft.geometryHash)throw s2SignatureBlock('HASH_MISMATCH','Allkirja puutepunktide kontrollsumma ei klapi.');
  const png=decode64(String(draft.pngBase64||'')),dimensions=s2PngDimensions(png),pngHash=await digest(png);
  if(dimensions.width!==900||dimensions.height!==300||pngHash!==draft.pngHash)throw s2SignatureBlock('HASH_MISMATCH','Allkirja PNG mõõtmed või kontrollsumma ei klapi.');
  if(Number(draft.strokeCount)!==strokes.points.reduce((m,p)=>Math.max(m,p[0]),0)||Number(draft.pointCount)!==strokes.points.length)throw s2SignatureBlock('STROKES_INVALID','Allkirja joonte või punktide arv ei klapi.');
  return {draft,metadata,strokes,geometry,png,recordHash:null,recordSnapshot:null,proof:null,proofHash:null,antiReuse:null};
}
function s2ResolvePart(sourcePart,target){
  let pieces=String(target||'').split('#')[0].split('?')[0].replace(/\\/g,'/').split('/');let out=String(target||'').startsWith('/')?[]:sourcePart.split('/').slice(0,-1);
  for(const raw of pieces){const part=decodeURIComponent(raw);if(!part||part==='.')continue;if(part==='..'){if(!out.length)throw s2SignatureBlock('OOXML_INVALID','Rich Data viide väljub töövihiku paketist.');out.pop();}else out.push(part);}
  return out.join('/');
}
async function s2ResolveRichPicture(zip,pictureCell){
  if(!pictureCell||pictureCell.getAttribute('t')!=='e'||!/^\d+$/.test(String(pictureCell.getAttribute('vm')||'')))throw s2SignatureBlock('PICTURE_BINDING_INVALID','Picture-in-Cell ei sisalda kehtivat Rich Data viidet.');
  const vm=Number(pictureCell.getAttribute('vm'));if(vm<1)throw s2SignatureBlock('PICTURE_BINDING_INVALID','Rich Data vm indeks on vigane.');
  const [meta,values,rels,relFile]=await Promise.all(['xl/metadata.xml','xl/richData/rdrichvalue.xml','xl/richData/richValueRel.xml','xl/richData/_rels/richValueRel.xml.rels'].map(path=>s2ParsePart(zip,path)));
  const future=qsa(meta,'futureMetadata').find(x=>x.getAttribute('name')==='XLRICHVALUE'),valueMeta=qsa(meta,'valueMetadata')[0];
  const futureBlocks=future?qsa(future,'bk'):[],valueBlocks=valueMeta?qsa(valueMeta,'bk'):[],rvNodes=qsa(values,'rv'),relNodes=qsa(rels,'rel'),packageRels=qsa(relFile,'Relationship');
  if(!future||!valueMeta||vm>futureBlocks.length||vm>valueBlocks.length||String(future.getAttribute('count'))!==String(futureBlocks.length)||String(valueMeta.getAttribute('count'))!==String(valueBlocks.length)||String(values.documentElement.getAttribute('count'))!==String(rvNodes.length)||rvNodes.length!==relNodes.length||relNodes.length!==packageRels.length)throw s2SignatureBlock('OOXML_INVALID','Rich Data indeksid või count-väärtused ei klapi.');
  const metaIndex=vm-1,rc=qsa(valueBlocks[metaIndex],'rc')[0],rvb=qsa(futureBlocks[metaIndex],'rvb')[0];
  if(!rc||rc.getAttribute('t')!=='1'||Number(rc.getAttribute('v'))!==metaIndex||!rvb||Number(rvb.getAttribute('i'))!==metaIndex)throw s2SignatureBlock('PICTURE_BINDING_INVALID','Picture-in-Cell metadata viited ei klapi.');
  const rv=qsa(values,'rv')[metaIndex],rvData=qsa(rv,'v').map(x=>x.textContent);if(!rv||rvData.length<2||Number(rvData[0])<0||Number(rvData[0])>=relNodes.length||rvData[1]!=='5')throw s2SignatureBlock('PICTURE_BINDING_INVALID','Picture-in-Cell Rich Data väärtus on vigane.');
  const richRel=relNodes[Number(rvData[0])],relationshipId=localAttr(richRel,'id'),imageRel=packageRels.find(x=>x.getAttribute('Id')===relationshipId);
  if(!relationshipId||!imageRel||imageRel.getAttribute('TargetMode')==='External'||!/\/image$/.test(imageRel.getAttribute('Type')||''))throw s2SignatureBlock('PICTURE_BINDING_INVALID','Rich Data pildi relationship puudub või on väline.');
  const mediaPath=s2ResolvePart('xl/richData/richValueRel.xml',imageRel.getAttribute('Target'));if(!mediaPath.startsWith('xl/media/')||mediaPath.includes('/../'))throw s2SignatureBlock('PICTURE_BINDING_INVALID','Rich Data pildi asukoht ei ole lubatud.');
  const media=zip.file(mediaPath);if(!media)throw s2SignatureBlock('ASSET_MISSING','Rich Data viidatud pildi osa puudub.');
  const png=await media.async('uint8array'),pngHash=await digest(png);return {mediaPath,png,pngHash,vm,metadataIndex:metaIndex,richValueIndex:Number(rvData[0]),relationshipId};
}
async function s2ValidateRichDataPackage(zip,imageDoc){
  const content=await s2ParsePart(zip,'[Content_Types].xml'),pngType=qsa(content,'Default').find(x=>String(x.getAttribute('Extension')).toLowerCase()==='png');
  if(!pngType||pngType.getAttribute('ContentType')!=='image/png')throw s2SignatureBlock('SIGNATURE_STRUCTURE_UNSUPPORTED','Töövihik ei deklareeri PNG-pilte kinnitatud image/png tüübina.');
  const pictureRows=s2Rows(imageDoc,6,500);
  for(const row of pictureRows){const cell=getCell(imageDoc,'F'+row);if(cell?.getAttribute('vm'))await s2ResolveRichPicture(zip,cell);}
  return true;
}
function s2ExistingSignatureRegistry(signaturesDoc,imagesDoc){
  const imageHashes=new Map();for(const row of s2Rows(imagesDoc,6,500)){const id=s2CellString(imagesDoc,'A',row);if(!id)continue;if(imageHashes.has(id))throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','Allkirjade piltide lehel kordub AllkiriID.');imageHashes.set(id,s2CellString(imagesDoc,'G',row)||null);}
  const registry=new Map();
  for(const row of s2Rows(signaturesDoc,5,500)){
    const id=s2CellString(signaturesDoc,'A',row);if(!id)continue;if(registry.has(id))throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','Allkirjade lehel kordub AllkiriID.');
    let proof=null;try{const raw=s2CellString(signaturesDoc,'BN',row);if(raw)proof=JSON.parse(raw);}catch(e){throw s2SignatureBlock('PROOF_INCOMPLETE','Olemasoleva allkirja Proof JSON ei ole loetav.');}
    registry.set(id,{signatureId:id,nonce:s2CellString(signaturesDoc,'BB',row)||proof?.nonce||null,strokeHash:s2CellString(signaturesDoc,'BG',row)||proof?.strokeHash||null,pngHash:s2CellString(signaturesDoc,'K',row)||s2CellString(signaturesDoc,'AX',row)||imageHashes.get(id)||proof?.pngHash||null,geometryHash:proof?.antiReuse?.geometryHash||null});
  }
  return registry;
}
function s2NormalizeRegistryTuple(tuple){
  const out={signatureId:String(tuple.signatureId||''),nonce:tuple.nonce||null,strokeHash:tuple.strokeHash||null,pngHash:tuple.pngHash||null,geometryHash:tuple.geometryHash||null};
  if(!out.signatureId)throw s2SignatureBlock('PROOF_INCOMPLETE','Kohalikus allkirjade registris puudub AllkiriID.');
  for(const key of ['strokeHash','pngHash','geometryHash'])if(out[key]!=null&&!/^[0-9a-f]{64}$/.test(String(out[key])))throw s2SignatureBlock('PROOF_INCOMPLETE',`Kohaliku registri ${key} ei ole SHA-256.`);
  if(out.nonce!=null&&!/^[0-9a-f]{64}$/.test(String(out.nonce)))throw s2SignatureBlock('PROOF_INCOMPLETE','Kohaliku registri nonce on vigane.');return out;
}
function s2MergeRegistryTuple(prior,incoming){
  const merged={...prior};for(const key of ['nonce','strokeHash','pngHash','geometryHash']){if(merged[key]!=null&&incoming[key]!=null&&merged[key]!==incoming[key])throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','Sama AllkiriID-ga kohalikud registrikirjed on vastuolus.');if(merged[key]==null&&incoming[key]!=null)merged[key]=incoming[key];}return merged;
}
async function s2CheckAntiReuse(candidate,workbookRegistry,localDrafts){
  const registry=new Map(workbookRegistry);
  for(const draft of localDrafts){const tuple=s2NormalizeRegistryTuple({signatureId:draft.signatureId,nonce:draft.nonce,strokeHash:draft.strokeHash,pngHash:draft.pngHash,geometryHash:draft.geometryHash});if(tuple.signatureId===candidate.signatureId)continue;registry.set(tuple.signatureId,registry.has(tuple.signatureId)?s2MergeRegistryTuple(registry.get(tuple.signatureId),tuple):tuple);}
  const matches=[];for(const [id,tuple] of registry){if(id===candidate.signatureId)continue;if(['nonce','strokeHash','pngHash','geometryHash'].some(key=>candidate[key]&&tuple[key]&&candidate[key]===tuple[key]))matches.push(id);}
  matches.sort();if(matches.length)throw s2SignatureBlock('DUPLICATE_CAPTURE',`Allkirja korduskasutuse kontroll leidis vaste: ${matches.join(', ')}. Mustand jäi telefoni.`);
  const entries=[...registry.values()].map(s2NormalizeRegistryTuple).sort((a,b)=>a.signatureId.localeCompare(b.signatureId));
  return {algorithm:'dold-exact-reuse/v1',result:'UNIQUE',scope:'LOCAL_KNOWN_DATA',checkedAtUtcMs:Date.now(),checkedCount:entries.length,registryDigest:await digest(new TextEncoder().encode(signatureCanonicalJson(entries))),matchingSignatureIds:[],geometryHash:candidate.geometryHash};
}
function s2FindControlTarget(doc,recordId,kilpId){
  const matches=qsa(doc,'row').map(row=>Number(row.getAttribute('r'))).filter(row=>row>=5&&getCellVal(doc,'AA',row)===recordId);
  if(matches.length===0)throw s2SignatureBlock('TARGET_NOT_FOUND','Püsiva KontrollID-ga kirjet ei leitud. Kontroll ja mustand jäid alles.');
  if(matches.length!==1)throw s2SignatureBlock('TARGET_NOT_UNIQUE','Püsiv KontrollID esineb mitu korda. Allkirja ei lisatud.');
  const row=matches[0];if(row>500||getCellVal(doc,'B',row)!==kilpId)throw s2SignatureBlock('TARGET_MISMATCH','KontrollID ja KilpID ei klapi kinnitatud allkirjaviitega.');return row;
}
function s2FindFreeSignatureRow(doc){
  for(let row=5;row<=500;row++){
    if(s2CellString(doc,'A',row))continue;
    const element=qsa(doc,'row').find(x=>Number(x.getAttribute('r'))===row),cells=element?qsa(element,'c'):[];
    const occupied=cells.some(cell=>{
      const col=refCol(cell.getAttribute('r')||'');if(isFormulaCell(cell)&&['G','T'].includes(col))return false;
      return s2CellHasValue(cell);
    });if(!occupied)return row;
  }
  throw s2SignatureBlock('CAPACITY_EXCEEDED','Allkirjade kinnitatud kirjete vahemik 5:500 on täis.');
}
function s2FindFreePictureRow(doc){
  for(let row=6;row<=500;row++){
    if(row===8||s2CellString(doc,'A',row)||s2CellString(doc,'B',row)||s2CellString(doc,'C',row)||s2CellString(doc,'D',row)||s2CellString(doc,'G',row)||s2CellString(doc,'H',row))continue;
    const picture=getCell(doc,'F'+row);if(picture&&s2CellHasValue(picture))continue;
    const e=getCell(doc,'E'+row);if(e&&isFormulaCell(e))continue;
    return row;
  }
  throw s2SignatureBlock('CAPACITY_EXCEEDED','Allkirjade pildilehe kinnitatud pildiread on täis.');
}
function s2StyleRow(doc,row,templateRow,startColumn,endColumn,height){
  const element=rowEl(doc,row);for(let index=startColumn;index<=endColumn;index++){
    const col=s2ColumnName(index),cell=ensureCell(doc,col,row),template=getCell(doc,col+templateRow);
    if(template?.hasAttribute('s'))cell.setAttribute('s',template.getAttribute('s'));else cell.removeAttribute('s');
    clearCellContent(cell);cell.removeAttribute('t');cell.removeAttribute('vm');cell.removeAttribute('cm');cell.removeAttribute('ph');
  }
  element.setAttribute('spans',`${startColumn}:${endColumn}`);if(height!=null){element.setAttribute('ht',String(height));element.setAttribute('customHeight','1');}
  return element;
}
function s2CopyTypedCell(sourceDoc,sourceCol,sourceRow,targetDoc,targetCol,targetRow){
  const typed=signatureTypedCellValue(sourceDoc,sourceCol,sourceRow);if(!typed)throw s2SignatureBlock('RECORD_SNAPSHOT_UNSUPPORTED',`Kontrolli väli ${sourceCol}${sourceRow} sisaldab valemit või vigast väärtust.`);
  const source=getCell(sourceDoc,sourceCol+sourceRow),target=ensureCell(targetDoc,targetCol,targetRow);clearCellContent(target);target.removeAttribute('t');
  if(typed.type==='blank')return;
  const type=source?.getAttribute('t');if(type)target.setAttribute('t',type);
  for(const child of source?.childNodes||[])if(['v','is'].includes(child.localName))target.appendChild(child.cloneNode(true));
}
function s2FormulaMap(doc){const result=new Map();for(const formula of qsa(doc,'f')){const ref=formula.parentNode?.getAttribute('r');if(ref)result.set(ref,formula.textContent||'');}return result;}
function s2AddSignatureRecord(doc,row,state,signatureRow,targetRow,mediaPath,priorSignatureId){
  s2StyleRow(doc,row,5,1,68,90);
  const draft=state.draft,proof=state.proof,snapshot=state.recordSnapshot,recordSnapshotText=signatureCanonicalJson(snapshot),proofText=signatureCanonicalJson(proof);
  if(recordSnapshotText.length>32767||proofText.length>32767)throw s2SignatureBlock('PROOF_INCOMPLETE','Allkirja payload ületab Exceli lahtri tekstipiiri.');
  const serial=draft.captureEndedAtUtcMs/86400000+25569,formulaG=signatureEffectiveStatusFormula('Kontroll',row),formulaT=signatureTargetFormula('Kontroll',row);
  setInline(doc,'A',row,draft.signatureId);setInline(doc,'B',row,'Kontroll');setInline(doc,'C',row,draft.recordId);setInline(doc,'D',row,draft.signerName);
  setNum(doc,'E',row,serial);setInline(doc,'F',row,'Kehtiv');s2SetFormulaCached(doc,'G',row,formulaG,'Kehtiv','string');
  setNum(doc,'I',row,Number(draft.recordVersion));setInline(doc,'J',row,state.recordHash);setInline(doc,'K',row,draft.pngHash);setInline(doc,'L',row,mediaPath);setNum(doc,'M',row,serial);
  if(priorSignatureId)setInline(doc,'O',row,priorSignatureId);else clearInput(doc,'O',row);
  setInline(doc,'R',row,S2_SIGNATURE_FORMATS.record);setInline(doc,'S',row,recordSnapshotText);s2SetFormulaCached(doc,'T',row,formulaT,targetRow-4,'number');
  for(const [sourceCol,snapshotCol] of SIGNATURE_SNAPSHOT_FIELDS.Kontroll)s2CopyTypedCell(state.controlDoc,sourceCol,targetRow,doc,snapshotCol,row);
  setInline(doc,'AX',row,draft.pngHash);setInline(doc,'AY',row,mediaPath);setInline(doc,'AZ',row,S2_SIGNATURE_FORMATS.proof);setInline(doc,'BA',row,state.proofHash);setInline(doc,'BB',row,draft.nonce);
  s2SetUtcExcelSerial(doc,'BC',row,Number(draft.captureStartedAtUtcMs));s2SetUtcExcelSerial(doc,'BD',row,Number(draft.captureEndedAtUtcMs));setInline(doc,'BE',row,draft.inputMethod);setInline(doc,'BF',row,S2_SIGNATURE_FORMATS.strokes);setInline(doc,'BG',row,draft.strokeHash);setNum(doc,'BH',row,Number(draft.strokeCount));setNum(doc,'BI',row,Number(draft.pointCount));setNum(doc,'BJ',row,Number(draft.canvasWidthPx));setNum(doc,'BK',row,Number(draft.canvasHeightPx));setInline(doc,'BL',row,'UNIQUE');clearInput(doc,'BM',row);setInline(doc,'BN',row,proofText);setInline(doc,'BO',row,draft.deviceInstanceId);setInline(doc,'BP',row,draft.appVersionName);
  const timeStyle=getCell(doc,'E5')?.getAttribute('s');if(timeStyle)for(const col of ['E','M','BC','BD'])ensureCell(doc,col,row).setAttribute('s',timeStyle);
  s2UpdateDimension(doc,'BP',row);
  return {recordSnapshotText,proofText};
}
async function s2MarkSignatureRevoked(doc,signatureId,recordId,reason,revokedAtUtcMs){
  const rows=s2SignatureRowsById(doc,signatureId);if(rows.length!==1)throw s2SignatureBlock('UNRESOLVED_TARGET','Eelmise AllkirjaID kirje puudub või kordub. Kontrolli andmeid ei muudetud.');
  const row=rows[0],stored=s2CellString(doc,'F',row);
  if(s2CellString(doc,'B',row)!=='Kontroll'||s2CellString(doc,'C',row)!==recordId||s2CellString(doc,'AZ',row)!==S2_SIGNATURE_FORMATS.proof)throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','Eelmise allkirja tüüp, püsiv ID või proof-vorming ei klapi.');
  if(stored==='Tühistatud'){
    if(!s2CellHasValue(getCell(doc,'P'+row))||!s2CellString(doc,'Q',row))throw s2SignatureBlock('PROOF_INCOMPLETE','Tühistatud allkirjal puudub aeg või põhjus.');
    return {row,changed:false};
  }
  if(stored!=='Kehtiv')throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','Aktiivse Kontrolli allkirja olek ei ole Kehtiv.');
  const proofText=s2CellString(doc,'BN',row);let proof;try{proof=JSON.parse(proofText);}catch(e){throw s2SignatureBlock('PROOF_INCOMPLETE','Eelmise allkirja proof ei ole loetav.');}
  if(proof.format!==S2_SIGNATURE_FORMATS.proof||proof.signatureId!==signatureId||proof.recordId!==recordId||s2CellString(doc,'BA',row)!==await digest(new TextEncoder().encode(signatureCanonicalJson(proof)))||signatureCanonicalJson(proof)!==proofText)throw s2SignatureBlock('PROOF_HASH_MISMATCH','Eelmise allkirja proof ei vasta talletatud SHA-256-le.');
  setInline(doc,'F',row,'Tühistatud');s2SetUtcExcelSerial(doc,'P',row,revokedAtUtcMs);setInline(doc,'Q',row,reason);
  s2SetFormulaCached(doc,'G',row,signatureEffectiveStatusFormula('Kontroll',row),'Tühistatud','string');
  return {row,changed:true};
}
function s2AppendStrokeRows(doc,signatureId,strokePoints){
  const sameId=s2Rows(doc,5,1048576).filter(row=>s2CellString(doc,'A',row)===signatureId);if(sameId.length)throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','Sama AllkiriID-ga on juba puutepunkte.');
  const used=s2Rows(doc,5,1048576).filter(row=>qsa(qsa(doc,'sheetData')[0],'row').some(x=>Number(x.getAttribute('r'))===row&&qsa(x,'c').some(s2CellHasValue)));
  let row=Math.max(4,...used)+1;if(row<5)row=5;if(row+strokePoints.length-1>1048576)throw s2SignatureBlock('CAPACITY_EXCEEDED','Allkirja puutepunktid ei mahu lehele Allkirja_jaljed.');
  for(const point of strokePoints){setInline(doc,'A',row,signatureId);for(let i=0;i<5;i++)setNum(doc,s2ColumnName(i+2),row,point[i]);row++;}
  s2UpdateDimension(doc,'F',row-1);
}
function s2AddPictureRow(doc,row,draft,signatureRow,metadataIndex,mediaPath){
  const template=qsa(doc,'row').find(x=>Number(x.getAttribute('r'))===6);if(!template)throw s2SignatureBlock('SIGNATURE_STRUCTURE_UNSUPPORTED','Allkirjade pildilehe Kontrolli näidisrida puudub.');
  s2StyleRow(doc,row,6,1,8,112.5);
  setInline(doc,'A',row,draft.signatureId);setInline(doc,'B',row,'Kontroll');setInline(doc,'C',row,draft.recordId);setInline(doc,'D',row,draft.kilpId);
  const eTemplate=qsa(getCell(doc,'E6'),'f')[0],eFormula=eTemplate?String(eTemplate.textContent||'').replace(/A6/g,`A${row}`):`IFERROR(INDEX(Allkirjad!$G$5:$G$500,MATCH(A${row},Allkirjad!$A$5:$A$500,0)),\"\")`;
  s2SetFormulaCached(doc,'E',row,'='+eFormula,'Kehtiv','string');
  const f=ensureCell(doc,'F',row);clearCellContent(f);f.setAttribute('t','e');f.setAttribute('vm',String(metadataIndex+1));const value=doc.createElementNS(f.namespaceURI,'v');value.textContent='#VALUE!';f.appendChild(value);
  setInline(doc,'G',row,draft.pngHash);setInline(doc,'H',row,mediaPath);s2UpdateDimension(doc,'H',row);
}
async function s2AppendRichData(zip,mediaPath,png){
  const paths={rels:'xl/richData/_rels/richValueRel.xml.rels',rich:'xl/richData/richValueRel.xml',values:'xl/richData/rdrichvalue.xml',meta:'xl/metadata.xml'};
  const [relDoc,richDoc,valueDoc,metaDoc]=await Promise.all(Object.values(paths).map(path=>s2ParsePart(zip,path)));
  const richRelNodes=qsa(richDoc,'rel'),rvNodes=qsa(valueDoc,'rv'),packageRelNodes=qsa(relDoc,'Relationship'),future=qsa(metaDoc,'futureMetadata').filter(x=>x.getAttribute('name')==='XLRICHVALUE'),valueMeta=qsa(metaDoc,'valueMetadata');
  if(future.length!==1||valueMeta.length!==1)throw s2SignatureBlock('OOXML_INVALID','Rich Data metadata plokk puudub või kordub.');
  const futureBlocks=qsa(future[0],'bk'),valueBlocks=qsa(valueMeta[0],'bk'),count=rvNodes.length;
  if(String(future[0].getAttribute('count'))!==String(futureBlocks.length)||String(valueMeta[0].getAttribute('count'))!==String(valueBlocks.length)||String(valueDoc.documentElement.getAttribute('count'))!==String(count)||count!==richRelNodes.length||count!==packageRelNodes.length||count!==futureBlocks.length||count!==valueBlocks.length)throw s2SignatureBlock('OOXML_INVALID','Rich Data count/index ei ole ühtlane; töövihikut ei muudetud.');
  const ids=new Set(packageRelNodes.map(x=>x.getAttribute('Id')));let n=1;while(ids.has('rId'+n))n++;const newId='rId'+n,index=count;
  const relationship=relDoc.createElementNS(relDoc.documentElement.namespaceURI,'Relationship');relationship.setAttribute('Id',newId);relationship.setAttribute('Type',S2_SIGNATURE_NS.rel+'/image');relationship.setAttribute('Target','../media/'+mediaPath.split('/').pop());relDoc.documentElement.appendChild(relationship);
  const richRel=richDoc.createElementNS(richDoc.documentElement.namespaceURI,'rel');richRel.setAttribute('r:id',newId);richDoc.documentElement.appendChild(richRel);
  valueDoc.documentElement.setAttribute('count',String(index+1));const rv=valueDoc.createElementNS(valueDoc.documentElement.namespaceURI,'rv');rv.setAttribute('s','0');let v=valueDoc.createElementNS(valueDoc.documentElement.namespaceURI,'v');v.textContent=String(index);rv.appendChild(v);v=valueDoc.createElementNS(valueDoc.documentElement.namespaceURI,'v');v.textContent='5';rv.appendChild(v);valueDoc.documentElement.appendChild(rv);
  future[0].setAttribute('count',String(index+1));const futureBk=metaDoc.createElementNS(metaDoc.documentElement.namespaceURI,'bk'),extList=metaDoc.createElementNS(metaDoc.documentElement.namespaceURI,'extLst'),ext=metaDoc.createElementNS(metaDoc.documentElement.namespaceURI,'ext');ext.setAttribute('uri',S2_SIGNATURE_NS.richExt);const rvb=metaDoc.createElementNS(S2_SIGNATURE_NS.rich,'xlrd:rvb');rvb.setAttribute('i',String(index));ext.appendChild(rvb);extList.appendChild(ext);futureBk.appendChild(extList);future[0].appendChild(futureBk);
  valueMeta[0].setAttribute('count',String(index+1));const valueBk=metaDoc.createElementNS(metaDoc.documentElement.namespaceURI,'bk'),rc=metaDoc.createElementNS(metaDoc.documentElement.namespaceURI,'rc');rc.setAttribute('t','1');rc.setAttribute('v',String(index));valueBk.appendChild(rc);valueMeta[0].appendChild(valueBk);
  zip.file(paths.rels,xmlStr(relDoc));zip.file(paths.rich,xmlStr(richDoc));zip.file(paths.values,xmlStr(valueDoc));zip.file(paths.meta,xmlStr(metaDoc));if(zip.file(mediaPath))throw s2SignatureBlock('MEDIA_PART_ALREADY_EXISTS','Allkirja PNG osa on töövihikus juba olemas.');zip.file(mediaPath,png,{binary:true,compression:'DEFLATE',compressionOptions:{level:6}});
  return {metadataIndex:index,relationshipId:newId};
}
function s2WorkbookSignatureRows(zip){return s2ParsePart(zip,S.paths.Allkirjad);}
async function s2ListLocalDrafts(signatureId,draft){
  if(!window.Android||typeof Android.listSignatureDrafts!=='function')throw s2SignatureBlock('REUSE_NOT_CHECKED','Telefoni allkirjade kohalikku registrit ei saa lugeda.');
  let result;try{result=JSON.parse(Android.listSignatureDrafts());}catch(e){throw s2SignatureBlock('REUSE_NOT_CHECKED','Telefoni allkirjade kohalik register ei ole loetav.');}
  if(!result?.ok||!Array.isArray(result.data))throw s2SignatureBlock('REUSE_NOT_CHECKED',result?.error||'Telefoni allkirjade kohalik register ei ole täielik.');
  const byId=new Map();for(const entry of result.data){if(!entry?.signatureId||byId.has(entry.signatureId))throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','Telefoni allkirjade registris kordub AllkiriID.');byId.set(entry.signatureId,entry);}
  const current=byId.get(signatureId);if(!current||current.nonce!==draft.nonce||current.strokeHash!==draft.strokeHash||current.pngHash!==draft.pngHash||current.geometryHash!==draft.geometryHash)throw s2SignatureBlock('PROOF_INCOMPLETE','Kohalik register ei kinnita selle allkirjamustandi sisu.');
  return [...byId.values()];
}
async function s2PrepareSignatureState(draft){
  const state=await s2ValidateDraft(draft);s2RequireSignatureStructure();
  const workbook=await s2ParsePart(S.zip,'xl/workbook.xml'),pr=qsa(workbook,'workbookPr')[0];if(pr&&['1','true'].includes(String(pr.getAttribute('date1904')||'').toLowerCase()))throw s2SignatureBlock('SCHEMA_UNSUPPORTED','1904 kuupäevasüsteemiga töövihiku allkirjaajad pole toetatud.');
  const controlDoc=await loadDoc('Kontrollid'),signatureDoc=await loadDoc('Allkirjad'),strokeDoc=await loadDoc('Allkirja_jaljed'),imageDoc=await loadDoc('Allkirjade pildid');
  await s2ValidateRichDataPackage(S.zip,imageDoc);
  const targetRow=s2FindControlTarget(controlDoc,draft.recordId,draft.kilpId);await reconcileKontrollSignatureVersions();
  const version=TC.signatureVersions[draft.recordId];if(!version||version.source!==KONTROLL_VERSION_SOURCE||version.recordVersion!==Number(draft.recordVersion)||version.snapshotHash!==draft.targetMetadata.recordVersionSnapshotHash)throw s2SignatureBlock('RECORD_CHANGED_DURING_CAPTURE','Kontrolli kaitstud andmed või kirjeversioon muutusid allkirja joonistamise ajal. Mustand jäi telefoni.');
  const snapshot=s2BuildRecordSnapshot(controlDoc,targetRow,draft.recordId,version.recordVersion),recordHash=await digest(new TextEncoder().encode(signatureCanonicalJson(snapshot)));
  if(snapshot.kilpId!==draft.kilpId||snapshot.inspectorName!==draft.signerName||snapshot.inspectionDate!==draft.targetMetadata.inspectionDate)throw s2SignatureBlock('RECORD_CHANGED_DURING_CAPTURE','Allkirja kontrollija, kilp või kuupäev ei vasta praegusele Kontrolli kirjele.');
  state.controlDoc=controlDoc;state.signatureDoc=signatureDoc;state.strokeDoc=strokeDoc;state.imageDoc=imageDoc;state.targetRow=targetRow;state.recordSnapshot=snapshot;state.recordHash=recordHash;
  const existingRows=s2SignatureRowsById(signatureDoc,draft.signatureId);
  if(existingRows.length){if(existingRows.length!==1)throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','AllkiriID esineb töövihikus mitu korda.');const verified=await s2VerifyExistingSignature(S.zip,state,existingRows[0]);if(!verified)throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','Sama AllkiriID on töövihikus teise või mittetäieliku sisuga.');state.already=true;return state;}
  if(s2Rows(strokeDoc,5,1048576).some(row=>s2CellString(strokeDoc,'A',row)===draft.signatureId))throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','Sama AllkiriID-ga puutepunktid on juba olemas, kuid Allkirjad kirje puudub.');
  const localDrafts=await s2ListLocalDrafts(draft.signatureId,draft),workbookRegistry=s2ExistingSignatureRegistry(signatureDoc,imageDoc),candidate={signatureId:draft.signatureId,nonce:draft.nonce,strokeHash:draft.strokeHash,pngHash:draft.pngHash,geometryHash:draft.geometryHash};
  state.antiReuse=await s2CheckAntiReuse(candidate,workbookRegistry,localDrafts);
  const proof={format:S2_SIGNATURE_FORMATS.proof,workbookIdentity:String(TC.dbId),signatureId:draft.signatureId,targetType:'Kontroll',recordId:draft.recordId,recordVersion:Number(draft.recordVersion),kilpId:draft.kilpId,signerName:draft.signerName,signedAtUtcMs:Number(draft.captureEndedAtUtcMs),captureStartedAtUtcMs:Number(draft.captureStartedAtUtcMs),captureEndedAtUtcMs:Number(draft.captureEndedAtUtcMs),captureDurationMs:Number(draft.captureDurationMs),inputMethod:draft.inputMethod,nonce:draft.nonce,deviceInstanceId:draft.deviceInstanceId,appVersionName:draft.appVersionName,appVersionCode:Number(draft.appVersionCode),androidRelease:draft.androidRelease,androidApiLevel:Number(draft.androidApiLevel),recordFormat:S2_SIGNATURE_FORMATS.record,recordHash,strokeFormat:S2_SIGNATURE_FORMATS.strokes,strokeHash:draft.strokeHash,pngHash:draft.pngHash,strokeCount:Number(draft.strokeCount),pointCount:Number(draft.pointCount),canvasWidthPx:Number(draft.canvasWidthPx),canvasHeightPx:Number(draft.canvasHeightPx),rendererProfile:draft.rendererProfile,clockSource:draft.clockSource,antiReuse:state.antiReuse};
  state.proof=proof;state.proofHash=await digest(new TextEncoder().encode(signatureCanonicalJson(proof)));
  const targetPointer=s2CellString(controlDoc,'AB',targetRow);if(targetPointer){const old=s2SignatureRowsById(signatureDoc,targetPointer);if(old.length!==1)throw s2SignatureBlock('UNRESOLVED_TARGET','Kontrolli varasem AllkiriID viitab puuduvale või korduvale allkirjale.');state.priorSignatureId=targetPointer;}
  state.signatureRow=s2FindFreeSignatureRow(signatureDoc);state.pictureRow=s2FindFreePictureRow(imageDoc);state.mediaPath=`xl/media/dold_sig_${draft.pngHash}.png`;
  return state;
}
async function s2VerifyExistingSignature(zip,state,row){
  const d=state.draft,id=d.signatureId,proofText=s2CellString(state.signatureDoc,'BN',row);let proof;try{proof=JSON.parse(proofText);}catch(e){return false;}
  if(s2CellString(state.signatureDoc,'B',row)!=='Kontroll'||s2CellString(state.signatureDoc,'C',row)!==d.recordId||s2CellString(state.signatureDoc,'F',row)!=='Kehtiv'||Number(s2CellString(state.signatureDoc,'I',row))!==Number(d.recordVersion)||s2CellString(state.signatureDoc,'J',row)!==state.recordHash||s2CellString(state.signatureDoc,'S',row)!==signatureCanonicalJson(state.recordSnapshot)||s2CellString(state.signatureDoc,'K',row)!==d.pngHash||s2CellString(state.signatureDoc,'BB',row)!==d.nonce||s2CellString(state.signatureDoc,'BG',row)!==d.strokeHash||s2CellString(state.signatureDoc,'BA',row)!==await digest(new TextEncoder().encode(signatureCanonicalJson(proof))))return false;
  if(proof.format!==S2_SIGNATURE_FORMATS.proof||proof.signatureId!==id||proof.recordId!==d.recordId||proof.recordVersion!==Number(d.recordVersion)||proof.recordHash!==state.recordHash||proof.strokeHash!==d.strokeHash||proof.pngHash!==d.pngHash||proof.nonce!==d.nonce||proof.captureStartedAtUtcMs!==Number(d.captureStartedAtUtcMs)||proof.captureEndedAtUtcMs!==Number(d.captureEndedAtUtcMs)||signatureCanonicalJson(proof)!==proofText)return false;
  const imageRows=s2Rows(state.imageDoc,6,500).filter(r=>s2CellString(state.imageDoc,'A',r)===id);if(imageRows.length!==1)return false;
  const image=await s2ResolveRichPicture(zip,getCell(state.imageDoc,'F'+imageRows[0]));if(image.pngHash!==d.pngHash||s2CellString(state.imageDoc,'G',imageRows[0])!==d.pngHash)return false;
  const strokeRows=s2Rows(state.strokeDoc,5,1048576).filter(r=>s2CellString(state.strokeDoc,'A',r)===id);if(strokeRows.length!==state.strokes.points.length)return false;
  for(let i=0;i<strokeRows.length;i++)for(let j=0;j<5;j++)if(Number(s2CellString(state.strokeDoc,s2ColumnName(j+2),strokeRows[i]))!==state.strokes.points[i][j])return false;
  return true;
}
async function s2AppendProductionSignature(state){
  const original=S.zip,candidate=cloneWorkbook(original),paths={signature:S.paths.Allkirjad,strokes:S.paths.Allkirja_jaljed,images:S.paths['Allkirjade pildid'],control:S.paths.Kontrollid};
  if(candidate.file(state.mediaPath))throw s2SignatureBlock('MEDIA_PART_ALREADY_EXISTS','Allkirja PNG failinimi on juba töövihikus kasutusel.');
  state.rich=await s2AppendRichData(candidate,state.mediaPath,state.png);
  const signatureDoc=await s2ParsePart(candidate,paths.signature),strokeDoc=await s2ParsePart(candidate,paths.strokes),imageDoc=await s2ParsePart(candidate,paths.images),controlDoc=await s2ParsePart(candidate,paths.control);
  if(state.priorSignatureId){state.revokedAtUtcMs=Date.now();state.revocationReason='Asendatud uue kinnitatud allkirjaga';await s2MarkSignatureRevoked(signatureDoc,state.priorSignatureId,state.draft.recordId,state.revocationReason,state.revokedAtUtcMs);}
  s2AddSignatureRecord(signatureDoc,state.signatureRow,state,state.signatureRow,state.targetRow,state.mediaPath,state.priorSignatureId);
  s2AppendStrokeRows(strokeDoc,state.draft.signatureId,state.strokes.points);
  s2AddPictureRow(imageDoc,state.pictureRow,state.draft,state.signatureRow,state.rich.metadataIndex,state.mediaPath);
  setInline(controlDoc,'AB',state.targetRow,state.draft.signatureId);
  candidate.file(paths.signature,xmlStr(signatureDoc));candidate.file(paths.strokes,xmlStr(strokeDoc));candidate.file(paths.images,xmlStr(imageDoc));candidate.file(paths.control,xmlStr(controlDoc));
  await s2VerifyProductionCandidate(original,candidate,state,paths);
  return candidate;
}
async function s2VerifyProductionCandidate(original,candidate,state,paths){
  const allowed=new Set([paths.signature,paths.strokes,paths.images,paths.control,'xl/richData/_rels/richValueRel.xml.rels','xl/richData/richValueRel.xml','xl/richData/rdrichvalue.xml','xl/metadata.xml',state.mediaPath]);
  for(const name of Object.keys(original.files))if(!original.files[name].dir){if(!candidate.file(name))throw s2SignatureBlock('OOXML_INVALID',`Töövihiku osa eemaldati: ${name}`);if(!allowed.has(name)&&await digest(await original.file(name).async('uint8array'))!==await digest(await candidate.file(name).async('uint8array')))throw s2SignatureBlock('OOXML_PRESERVATION_FAILED',`Muutmata töövihiku osa muutus: ${name}`);}
  const added=Object.keys(candidate.files).filter(name=>!candidate.files[name].dir&&!original.file(name));if(added.length!==1||added[0]!==state.mediaPath)throw s2SignatureBlock('OOXML_PRESERVATION_FAILED','Allkirjastamise käigus lisandus ootamatu töövihiku osa.');
  for(const path of [paths.signature,paths.images]){const before=await s2ParsePart(original,path),after=await s2ParsePart(candidate,path),prior=s2FormulaMap(before),next=s2FormulaMap(after);for(const [cell,formula] of prior)if(next.get(cell)!==formula)throw s2SignatureBlock('OOXML_PRESERVATION_FAILED',`Olemasolev valem muutus: ${path}!${cell}`);}
  const signatureDoc=await s2ParsePart(candidate,paths.signature),strokeDoc=await s2ParsePart(candidate,paths.strokes),imageDoc=await s2ParsePart(candidate,paths.images),controlDoc=await s2ParsePart(candidate,paths.control);
  const signatureRows=s2SignatureRowsById(signatureDoc,state.draft.signatureId),imageRows=s2Rows(imageDoc,6,500).filter(row=>s2CellString(imageDoc,'A',row)===state.draft.signatureId);
  if(signatureRows.length!==1||imageRows.length!==1||s2CellString(signatureDoc,'F',signatureRows[0])!=='Kehtiv'||s2CellString(signatureDoc,'BA',signatureRows[0])!==state.proofHash||s2CellString(signatureDoc,'J',signatureRows[0])!==state.recordHash||s2CellString(controlDoc,'AB',state.targetRow)!==state.draft.signatureId)throw s2SignatureBlock('OOXML_INVALID','Allkirja kirje, pildikirje või Kontrolli viide ei klapi.');
  if(state.priorSignatureId){const priorRows=s2SignatureRowsById(signatureDoc,state.priorSignatureId);if(priorRows.length!==1||s2CellString(signatureDoc,'F',priorRows[0])!=='Tühistatud'||!s2CellString(signatureDoc,'Q',priorRows[0]))throw s2SignatureBlock('SIGNATURE_ID_CONFLICT','Eelmist allkirja ei tühistatud aatomiliselt.');}
  const allProof=s2CellString(signatureDoc,'BN',signatureRows[0]);if(allProof!==signatureCanonicalJson(state.proof)||await digest(new TextEncoder().encode(allProof))!==state.proofHash)throw s2SignatureBlock('PROOF_HASH_MISMATCH','Proof JSON või ProofHash ei klapi.');
  const recordText=s2CellString(signatureDoc,'S',signatureRows[0]);if(recordText!==signatureCanonicalJson(state.recordSnapshot)||await digest(new TextEncoder().encode(recordText))!==state.recordHash)throw s2SignatureBlock('RECORD_HASH_MISMATCH','Kontrolli payload või RecordHash ei klapi.');
  const pixelCell=getCell(imageDoc,'F'+imageRows[0]);if(Number(pixelCell?.getAttribute('vm'))!==state.rich.metadataIndex+1)throw s2SignatureBlock('PICTURE_BINDING_INVALID','Picture-in-Cell vm indeks ei klapi.');
  const picture=await s2ResolveRichPicture(candidate,pixelCell);if(picture.pngHash!==state.draft.pngHash||picture.mediaPath!==state.mediaPath||s2CellString(imageDoc,'G',imageRows[0])!==state.draft.pngHash)throw s2SignatureBlock('HASH_MISMATCH','Rich Data viide ei lahenda allkirja PNG baite õigesti.');
  const imageRow=qsa(imageDoc,'row').find(x=>Number(x.getAttribute('r'))===imageRows[0]);if(Number(imageRow?.getAttribute('ht'))!==112.5||imageRow?.getAttribute('customHeight')!=='1')throw s2SignatureBlock('PICTURE_BINDING_INVALID','Allkirjapildi rea kõrgus ei vasta kinnitatud kujule.');
  const strokeRows=s2Rows(strokeDoc,5,1048576).filter(row=>s2CellString(strokeDoc,'A',row)===state.draft.signatureId);if(strokeRows.length!==state.strokes.points.length)throw s2SignatureBlock('STROKES_INVALID','Kõiki allkirja puutepunkte ei kirjutatud.');
  for(let i=0;i<strokeRows.length;i++)for(let j=0;j<5;j++)if(Number(s2CellString(strokeDoc,s2ColumnName(j+2),strokeRows[i]))!==state.strokes.points[i][j])throw s2SignatureBlock('STROKES_INVALID','Allkirja puutepunkt muutus XLSX-i kirjutamisel.');
  await s2ValidateRichDataPackage(candidate,imageDoc);state.rich=state.rich||{metadataIndex:Number(pixelCell.getAttribute('vm'))-1};
}
async function commitProductionSignature(signatureId){
  if(!TC.ready||!S.zip)throw s2SignatureBlock('WORKBOOK_NOT_OPEN','Ava aktiivne tööfail enne allkirja salvestamist.');
  if(!window.Android||typeof Android.readSignatureDraft!=='function')throw s2SignatureBlock('ANDROID_DRAFT_UNAVAILABLE','Telefoni allkirjamustandit ei saa turvaliselt lugeda.');
  let envelope;try{envelope=JSON.parse(Android.readSignatureDraft(signatureId));}catch(e){throw s2SignatureBlock('ANDROID_DRAFT_UNAVAILABLE','Telefoni allkirjamustandit ei saa lugeda.');}
  if(!envelope?.ok||!envelope.data)throw s2SignatureBlock('ANDROID_DRAFT_UNAVAILABLE',envelope?.error||'Telefoni allkirjamustandit ei leitud.');
  const draft=envelope.data;let state=null;
  const committed=await transaction(async()=>{
    state=await s2PrepareSignatureState(draft);
    if(state.already)return;
    // Apply every staged part to one clone; no workbook part is published before all checks pass.
    const candidate=await s2AppendProductionSignature({...state,rich:state.rich});S.zip=candidate;S.dirty=true;
  },{skipSemanticJournal:true,rollbackMessage:'Allkirja XLSX-i tehing ebaõnnestus. Kontroll jäi salvestatuks ja allkirja mustand jäi telefoni.'});
  if(!committed)return {ok:false,already:false};
  if(!state)throw s2SignatureBlock('TRANSACTION_FAILED','Allkirja XLSX-tehing ei jõudnud tulemuseni.');
  if(state.already)return {ok:true,already:true,signatureId};
  const verifyDoc=await loadDoc('Allkirjad'),savedRows=s2SignatureRowsById(verifyDoc,signatureId);if(savedRows.length!==1||s2CellString(verifyDoc,'F',savedRows[0])!=='Kehtiv'||s2CellString(verifyDoc,'BA',savedRows[0])!==state.proofHash)throw s2SignatureBlock('TRANSACTION_VERIFY_FAILED','Allkirja salvestamist ei saanud pärast tehingut kinnitada. Kohalik mustand jäi alles.');
  return {ok:true,already:false,signatureId,recordId:draft.recordId};
}
async function retryProductionSignature(signatureId){
  try{const result=await commitProductionSignature(signatureId);if(result.ok)toast(result.already?'Allkiri oli juba tööfaili salvestatud.':'Allkiri kinnitati tööfailis. Olek: Kehtiv.',4500);else toast('Allkirja mustand jäi telefoni. XLSX-i salvestamist saab hiljem uuesti proovida.',5000);}
  catch(e){toast(`Allkirja mustand jäi telefoni. ${e.message||'XLSX-i salvestamine ebaõnnestus.'}`,6500);}
  await refreshSignatureDrafts();
}
function finishPendingPostSaveSignatureNavigation(){
  const pending=pendingPostSaveSignatureNavigation;if(!pending)return false;
  pendingPostSaveSignatureNavigation=null;
  if(pending.goNext)openNextCabinet(pending.cabinetId);else showTab('cab');
  return true;
}
function completePostSaveSignatureWithoutDraft(reason){
  if(!pendingPostSaveSignatureNavigation)return false;
  toast(`Kontroll salvestatud. Allkirja mustand jäi lisamata.${reason?' '+reason:''}`,5000);
  finishPendingPostSaveSignatureNavigation();return true;
}
function startNativeSignatureCapture(target){
  if(!window.Android||typeof Android.startSignatureCapture!=='function'){if(!completePostSaveSignatureWithoutDraft('Allkirjastamise aken pole saadaval.'))toast('Allkirja mustand vajab Androidi rakendust.');return false;}
  const payload={...target,deviceInstanceId:TC.deviceId||installationDeviceId()};
  try{const started=Android.startSignatureCapture(JSON.stringify(payload));if(!started){if(!completePostSaveSignatureWithoutDraft('Allkirjastamise akent ei saanud avada.'))toast('Allkirja mustandit ei saanud alustada.');return false;}return true;}
  catch(e){if(!completePostSaveSignatureWithoutDraft('Allkirjastamise akent ei saanud avada.'))toast('Allkirja mustandit ei saanud alustada.');return false;}
}
async function startKontrollSignatureDraft(record){
  const id=persistentSyncId('Kontroll',record?.persistentId||record?.syncId);if(!id){toast('Sellel kontrollil puudub püsiv KontrollID.');return false;}
  try{
    const version=await draftKontrollRecordVersion(record);await persistWorkspace();
    return startNativeSignatureCapture({targetType:'Kontroll',recordId:id,kilpId:record.id,signerName:record.inspector,recordVersion:version.recordVersion,recordVersionSource:version.recordVersionSource,metadata:{workbookIdentity:TC.dbId||'',inspectionDate:record.date||'',inspectorName:record.inspector||'',recordVersionSnapshotHash:version.recordVersionSnapshotHash||''}});
  }catch(e){if(!completePostSaveSignatureWithoutDraft('Allkirja mustandit ei saanud telefoni salvestada. XLSX jäi muutmata.'))toast('Allkirja kirjeversiooni ei saanud telefoni salvestada. XLSX jäi muutmata.');return false;}
}
function startParandusSignatureDraft(record){
  const recordId=String(record?.recordId||record?.parandusId||'').trim(),rawVersion=record?.recordVersion??record?.version??null,version=Number(rawVersion),knownVersion=Number.isSafeInteger(version)&&version>=1;
  return startNativeSignatureCapture({targetType:'Parandus',recordId,kilpId:record?.kilpId||record?.cabinetId||'',signerName:record?.signerName||record?.performedBy||'',recordVersion:knownVersion?version:null,recordVersionSource:knownVersion?'PARANDUSED_L':'UNRESOLVED',metadata:{workbookIdentity:TC.dbId||'',puudusId:record?.puudusId||'',kontrollId:record?.kontrollId||''}});
}
window.startDoldSignatureCapture=startNativeSignatureCapture;
window.startDoldParandusSignatureDraft=startParandusSignatureDraft;
async function onNativeSignatureDraftSaved(raw){
  let draft;
  try{draft=typeof raw==='string'?JSON.parse(raw):raw;if(!draft?.signatureId)throw Error('AllkiriID puudub');}
  catch(e){toast('Allkirja mustand salvestati telefoni, kuid seda ei saanud tööfailiga siduda.',5500);await refreshSignatureDrafts();finishPendingPostSaveSignatureNavigation();return null;}
  try{
    const result=await commitProductionSignature(draft.signatureId);
    toast(result.already?'Allkiri on selles tööfailis juba salvestatud. Olek: Kehtiv.':'Allkiri kinnitati tööfailis. Olek: Kehtiv.',5000);
  }catch(e){toast(`Kontroll salvestatud. Allkirja mustand jäi telefoni; XLSX-i kinnitamine ebaõnnestus. ${e.message||''}`,7000);}
  await refreshSignatureDrafts();finishPendingPostSaveSignatureNavigation();return draft;
}
function onNativeSignatureCaptureCancelled(reason){
  if(completePostSaveSignatureWithoutDraft(''))return;
  if(reason&&String(reason).includes('suurus muutus'))toast(reason,4500);
}
function onNativeSignatureCaptureError(message){
  if(completePostSaveSignatureWithoutDraft(message?`Allkirjastamise aken ei avanenud: ${message}`:'Allkirjastamise aken ei avanenud.'))return;
  toast(message||'Allkirjastamist ei saanud alustada.',4500);
}
async function signatureDraftWorkbookStatus(draft){
  if(draft?.targetType!=='Kontroll'||!TC.ready||!S.zip)return {label:'Tööfailis lisamata',saved:false,retryable:draft?.targetType==='Kontroll'};
  try{
    await reconcileKontrollSignatureVersions();
    const signatureDoc=await loadDoc('Allkirjad'),rows=s2SignatureRowsById(signatureDoc,String(draft.signatureId||''));
    if(!rows.length)return {label:'XLSX-i lisamata',saved:false,retryable:true};
    if(rows.length!==1)return {label:'Allkirja ID kordub',saved:false,retryable:false};
    const row=rows[0],controlDoc=await loadDoc('Kontrollid'),targets=qsa(controlDoc,'row').filter(x=>getCellVal(controlDoc,'AA',Number(x.getAttribute('r')))===draft.recordId);
    const current=TC.signatureVersions?.[draft.recordId],version=Number(s2CellString(signatureDoc,'I',row)),pointer=targets.length===1?s2CellString(controlDoc,'AB',Number(targets[0].getAttribute('r'))):'';
    if(s2CellString(signatureDoc,'F',row)==='Tühistatud'||(current&&current.recordVersion!==version))return {label:'Tühistatud',saved:true,retryable:false};
    if(pointer&&pointer!==draft.signatureId)return {label:'Asendatud uuema allkirjaga',saved:true,retryable:false};
    if(s2CellString(signatureDoc,'F',row)==='Kehtiv'&&s2CellString(signatureDoc,'C',row)===draft.recordId&&s2CellString(signatureDoc,'B',row)==='Kontroll')return {label:'Kehtiv (kohalikult kontrollitud)',saved:true,retryable:false};
    return {label:'Tööfaili kirje vajab kontrolli',saved:false,retryable:false};
  }catch(e){return {label:'Tööfaili olekut ei saanud kontrollida',saved:false,retryable:false};}
}
async function refreshSignatureDrafts(){
  const host=$('signatureDraftList');if(!host)return;
  if(!window.Android||typeof Android.listSignatureDrafts!=='function'){host.innerHTML='<div class="small">Allkirja mustandid on Androidi lokaalses salvestuses.</div>';return;}
  try{
    const result=JSON.parse(Android.listSignatureDrafts());if(!result.ok)throw Error(result.error||'Mustandeid ei saanud lugeda');
    const drafts=Array.isArray(result.data)?result.data:[];
    if(!drafts.length){host.innerHTML='<div class="small">Salvestatud allkirja mustandeid pole.</div>';return;}
    const cards=[];for(const d of drafts.slice().reverse()){
      const state=await signatureDraftWorkbookStatus(d),retry=d.targetType==='Kontroll'&&state.retryable?`<button class="topgap" onclick="retryProductionSignature('${esc(d.signatureId)}')">KINNITA XLSX-I</button>`:'';
      cards.push(`<div class="miniDef"><b>${esc(d.targetType)} • ${esc(d.kilpId)} • MUSTAND</b><div>${esc(d.signerName)} • ${esc(localDateTime(d.captureEndedAtUtcMs))}</div><div class="small">${esc(d.recordId)} • XLSX: ${esc(state.label)} • korduskontroll: ${esc(d.antiReuse?.result||'NOT_CHECKED')} (${esc(d.antiReuse?.scope||'LOCAL_KNOWN_DATA')})</div>${retry}</div>`);
    }
    host.innerHTML=cards.join('');
  }catch(e){host.innerHTML=`<div class="badge warn">${esc(e.message||'Allkirja mustandeid ei saanud lugeda.')}</div>`;}
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
  if(S.qrMode==='directSync')return handleDirectSyncQr(raw);
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
    const storedControlId=String(getCellVal(ctr,'AA',row)||'').trim(),storedControlSyncId=persistentSyncId('Kontroll',storedControlId),openedControlId=persistentSyncId('Kontroll',opened.existing?.syncId);
    if(storedControlId&&!storedControlSyncId)throw Error('Kontrolli püsiv ID on vigane; tööfaili ei muudetud.');
    if(storedControlSyncId&&openedControlId&&storedControlSyncId!==openedControlId)throw Error('Kontrolli püsiv ID on vahepeal muutunud.');
    if(!opened.existing&&storedControlId)throw Error('Uue kontrolli reale on juba püsiv ID salvestatud.');
    const controlId=wasNewDuplicate?newPersistentSyncId('Kontroll'):(storedControlSyncId||openedControlId||newPersistentSyncId('Kontroll'));
    const priorSignatureId=opened.existing?String(getCellVal(ctr,'AB',row)||'').trim():'';
    const priorSignatureSnapshot=priorSignatureId?kontrollVersionSnapshot(ctr,row,controlId):null;
    if(priorSignatureId&&!priorSignatureSnapshot)throw Error('Allkirjastatud Kontrolli hetktõmmist ei saa turvaliselt muuta. Tööfaili ei muudetud.');
    const priorSignatureSnapshotHash=priorSignatureSnapshot?await digest(new TextEncoder().encode(signatureCanonicalJson(priorSignatureSnapshot))):null;
    writeSyncText(ctr,'AA',row,controlId);
    setDate(ctr,'A',row,date);setInline(ctr,'B',row,c.id);setInline(ctr,'D',row,inspector);
    for(const [col,val] of [['C',c.area],['E',c.panel],['F',c.device],['G',c.location]])if(!isFormulaCell(getCell(ctr,col+row)))setInline(ctr,col,row,val);
    for(const [col] of CHECKS){const v=String(S.ratings[col]??'');if(v!=='')setNum(ctr,col,row,Number(v));else clearInput(ctr,col,row);}
    if(!wasEdit||opened.existing.start===''){setDateTime(ctr,'W',row,start);ensureCell(ctr,'W',row).setAttribute('s',styles.time);}
    setDateTime(ctr,'X',row,ended);ensureCell(ctr,'X',row).setAttribute('s',styles.time);setNum(ctr,'Y',row,duration/86400);ensureCell(ctr,'Y',row).setAttribute('s',styles.duration);
    S.zip.file(S.paths.Kontrollid,xmlStr(ctr));
    const linked=TC.cycle.entries[c.id]?.defectRows||[],defectRows=[...linked];
    for(const d of S.stagedDefects){
      let rr=d.existingRow;
      if(rr){if(getCellVal(def,'B',rr)!==c.id||getCellVal(def,'M',rr))throw Error('Puudus on vahepeal muutunud või suletud');const stored=String(getCellVal(def,'S',rr)||'').trim(),storedId=persistentSyncId('Puudus',stored);if(stored&&!storedId)throw Error('Puuduse püsiv ID on vigane; tööfaili ei muudetud.');if(storedId&&d.syncId&&storedId!==d.syncId)throw Error('Puuduse püsiv ID on vahepeal muutunud.');}
      else{rr=firstEmptyRow(def,'B',5,Math.max(10000,...qsa(def,'row').map(x=>Number(x.getAttribute('r'))))+1);setDate(def,'A',rr,date);setInline(def,'B',rr,c.id);setInline(def,'E',rr,inspector);for(const [col,val] of [['C',cabinetTitle(c)],['D',c.location]])if(!isFormulaCell(getCell(def,col+rr)))setInline(def,col,rr,val);writeSyncText(def,'S',rr,newPersistentSyncId('Puudus'));writeSyncText(def,'T',rr,controlId);writeSyncText(def,'U',rr,'DIRECT');writeSyncText(def,'V',rr,'ANDROID CREATE');defectRows.push(rr);}
      for(const [col,val] of [['F',d.point],['G',d.desc],['H',d.grade],['I',d.repeat],['J',d.owner]])setInline(def,col,rr,val||'');if(d.due)setDate(def,'K',rr,d.due);else clearInput(def,'K',rr);
    }
    if(S.stagedDefects.length)S.zip.file(S.paths.Puudused,xmlStr(def));
    if(status!==c.status){const sum=await loadDoc('Kokkuvõte');setInline(sum,'H',c.row,status);S.zip.file(S.paths['Kokkuvõte'],xmlStr(sum));}
    if(priorSignatureId){
      const updatedSnapshot=kontrollVersionSnapshot(ctr,row,controlId);
      const updatedHash=updatedSnapshot?await digest(new TextEncoder().encode(signatureCanonicalJson(updatedSnapshot))):null;
      if(!updatedHash)throw Error('Allkirjastatud Kontrolli uut hetktõmmist ei saa kontrollida. Tööfaili ei muudetud.');
      if(updatedHash!==priorSignatureSnapshotHash){
        const signatures=await loadDoc('Allkirjad');
        await s2MarkSignatureRevoked(signatures,priorSignatureId,controlId,'Kontrolli andmeid muudeti rakenduses',Date.now());
        S.zip.file(S.paths.Allkirjad,xmlStr(signatures));
      }
    }
    const fingerprint=recordFingerprint({id:c.id,date,inspector,start:getCellVal(ctr,'W',row)});
    const priorEntry=TC.cycle.entries[c.id]||{},oldControl=priorEntry.kontrollId||TC.records.find(r=>r.id===c.id&&r.row===priorEntry.row&&(!priorEntry.fingerprint||recordFingerprint(r)===priorEntry.fingerprint))?.syncId;
    const additionalIds=new Set(priorEntry.additionalKontrollIds||[]);if(wasNewDuplicate&&oldControl)additionalIds.add(oldControl);
    const previousControlDefects={...(priorEntry.previousControlDefects||{})};if(wasNewDuplicate&&oldControl&&priorEntry.defectRows?.length)previousControlDefects[oldControl]=[...new Set([...(previousControlDefects[oldControl]||[]),...priorEntry.defectRows])];
    TC.cycle.entries[c.id]={...priorEntry,row,fingerprint,kontrollId:controlId,defectRows:[...new Set(wasNewDuplicate?defectRows.filter(x=>!priorEntry.defectRows?.includes(x)):defectRows)],note:$('inspectComment').value,...(wasNewDuplicate&&additionalIds.size?{additionalKontrollIds:[...additionalIds]}:{}),...(Object.keys(previousControlDefects).length?{previousControlDefects}:{})};
    if(TC.guard.pending&&opened.proved){TC.guard.pending=null;TC.guard.remaining=randomGap();}else if(!opened.proved&&!wasEdit)TC.guard.remaining=Math.max(1,TC.guard.remaining-1);
    S.inspector=inspector;S.dirty=true;
  });
  if(ok){
    stopInspectionTimer();TC.opened=null;toast(`${c.id} ${wasEdit?'muudatused ':''}salvestatud telefoni • ${Math.round(duration)} s`);
    const controlId=persistentSyncId('Kontroll',TC.cycle?.entries?.[c.id]?.kontrollId),savedRecord=controlId?TC.records.find(r=>r.id===c.id&&r.syncId===controlId):null;
    if(!savedRecord){toast('Kontroll salvestatud. Allkirja mustand jäi lisamata, sest salvestatud KontrollID kirjet ei leitud.',5000);if(goNext)openNextCabinet(c.id);else showTab('cab');return;}
    pendingPostSaveSignatureNavigation={cabinetId:c.id,controlId,goNext:!!goNext};
    const started=await startKontrollSignatureDraft(savedRecord);
    if(!started&&pendingPostSaveSignatureNavigation)completePostSaveSignatureWithoutDraft('Allkirjastamise akent ei saanud avada.');
  }
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
  const state={schema:1,dbId:snapshot.dbId,fileName:snapshot.fileName,registryKey:snapshot.registryKey,registryTokens:snapshot.registryTokens,cycle,checkedIds,sync:snapshot.sync||null,signatureVersions:normalizeSignatureVersionMap(snapshot.signatureVersions),guard:snapshot.guard,revision:snapshot.revision,updatedAt:snapshot.updatedAt,lastUsedAt:snapshot.lastUsedAt,sourceHash:snapshot.sourceHash,workbookHash:snapshot.workbookHash,inspector:snapshot.inspector,dirty:snapshot.dirty,summary,baseWorkbookSha256:baseBytes?await digest(baseBytes):null};
  const stateBytes=new TextEncoder().encode(JSON.stringify(state)),workbookHash=await digest(workbookBytes),stateHash=await digest(stateBytes),baseHash=baseBytes?await digest(baseBytes):null;
  const zip=new JSZip();zip.file('workbook.xlsx',workbookBytes);zip.file('state.json',stateBytes);if(baseBytes)zip.file('base-workbook.xlsx',baseBytes);
  const manifest={format:WORK_PACKAGE_FORMAT,version:1,createdAt:new Date().toISOString(),sourceAppVersion:APP_VERSION,dbId:state.dbId,fileName:state.fileName,workbook:{path:'workbook.xlsx',sha256:workbookHash,size:workbookBytes.length},state:{path:'state.json',dbId:state.dbId,sha256:stateHash,size:stateBytes.length},baseWorkbook:baseBytes?{path:'base-workbook.xlsx',sha256:baseHash,size:baseBytes.length}:null,summary};
  zip.file('manifest.json',JSON.stringify(manifest,null,2));return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
}
async function shareWorkPackage(){
  if(TC.busy||!S.zip||!TC.dbId)return;setBusy(true);
  try{const bytes=await createWorkPackageBytes(),name=workPackageName();if(window.Android&&typeof Android.beginShareFile==='function')await shareXlsxNative(bytes,name,WORK_PACKAGE_MIME);else if(navigator.share&&typeof File==='function')await navigator.share({files:[new File([bytes],name,{type:WORK_PACKAGE_MIME})],title:'DOLD TechControl töö üleandmine'});else throw Error('Selles telefonis puudub failide jagamise võimalus.');toast('Tööpakett on Androidi jagamismenüüs valmis',4000);renderCyclePanel();}
  catch(e){if(e?.name!=='AbortError')alert('Töö üleandmine ebaõnnestus. Telefoni töö jäi alles.\n'+e.message);}finally{setBusy(false);}
}
const SYNC_PACKAGE_FORMAT='DOLD-TECHCONTROL-SYNC-PACKAGE';
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
  const state={schema:1,dbId:snapshot.dbId,fileName:snapshot.fileName,registryKey:snapshot.registryKey,registryTokens:snapshot.registryTokens,cycle:snapshot.cycle,sync:snapshot.sync,signatureVersions:normalizeSignatureVersionMap(snapshot.signatureVersions),revision:snapshot.revision,updatedAt:snapshot.updatedAt,sourceHash:snapshot.sourceHash,workbookHash,inspector:snapshot.inspector,dirty:snapshot.dirty,summary};
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
const DIRECT_SYNC_QR_PREFIX='DOLD-DIRECT-SYNC/1:';
const DIRECT_SYNC_BOOTSTRAP_FORMAT='DOLD-TECHCONTROL-DIRECT-BOOTSTRAP';
const DIRECT_SYNC_COMMIT_FORMAT='DOLD-TECHCONTROL-DIRECT-SYNC-COMMIT';
const DIRECT_SYNC_MAX_BYTES=1024*1024;
let directHostGeneration=0;
function supportsR4DirectSync(){return !!(window.Android&&typeof Android.startLanSyncSessionDeferred==='function'&&typeof Android.respondLanSyncSession==='function');}
function directPairingPayload(pairing){
  const info={protocol:Number(pairing?.protocol),host:String(pairing?.host||''),port:Number(pairing?.port),sessionId:String(pairing?.sessionId||''),token:String(pairing?.token||''),createdAt:Number(pairing?.createdAt),expiresAt:Number(pairing?.expiresAt),lineage:String(pairing?.lineage||'')};
  const payload=DIRECT_SYNC_QR_PREFIX+JSON.stringify(info);parseDirectSyncQr(payload);return payload;
}
function isPrivateIpv4Text(host){
  const m=String(host||'').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);if(!m)return false;
  const a=m.slice(1).map(Number);if(a.some(n=>n<0||n>255))return false;
  return a[0]===10||(a[0]===172&&a[1]>=16&&a[1]<=31)||(a[0]===192&&a[1]===168);
}
function parseDirectSyncQr(raw,now=Date.now()){
  const text=String(raw||'').trim();if(!text.startsWith(DIRECT_SYNC_QR_PREFIX))throw Error('NOT_DOLD_SYNC_QR');
  let p;try{p=JSON.parse(text.slice(DIRECT_SYNC_QR_PREFIX.length));}catch(e){throw Error('MALFORMED_QR');}
  if(!p||p.protocol!==1||!isPrivateIpv4Text(p.host)||!Number.isInteger(p.port)||p.port<1||p.port>65535
    ||typeof p.sessionId!=='string'||!/^[-_A-Za-z0-9]{22}$/.test(p.sessionId)
    ||typeof p.token!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(p.token)
    ||!Number.isFinite(p.createdAt)||!Number.isFinite(p.expiresAt)
    ||typeof p.lineage!=='string'||! /^[a-f0-9]{64}$/.test(p.lineage))throw Error('MALFORMED_QR');
  if(p.createdAt>now+30000||p.expiresAt<=now||p.expiresAt<=p.createdAt||p.expiresAt-p.createdAt>300000)throw Error('QR_EXPIRED');
  return {protocol:p.protocol,host:p.host,port:p.port,sessionId:p.sessionId,token:p.token,createdAt:p.createdAt,expiresAt:p.expiresAt,lineage:p.lineage};
}
function directSyncErrorText(code){
  if(code==='QR_EXPIRED'||code==='SESSION_EXPIRED')return 'QR-kood on aegunud. Loo esimeses telefonis uus QR.';
  if(code==='AUTH_FAILED')return 'Vale sünkroonimiskood.';
  if(code==='LINEAGE_MISMATCH')return 'Telefonid ei kasuta sama tööbaasi.';
  if(code==='NO_LOCAL_NETWORK')return 'Kohalik võrk pole saadaval. Mõlemad telefonid peavad olema samas Wi-Fi / LAN võrgus.';
  if(code==='PAYLOAD_TOO_LARGE')return 'Tööbaasi pakett on kohaliku ühenduse jaoks liiga suur. Kasuta paketiga sünkroonimist.';
  if(code==='INTEGRITY_FAILURE'||code==='MALFORMED_RESPONSE'||code==='MALFORMED_REQUEST')return 'Ühenduse andmed ei läbinud kontrolli. Telefoni töö jäi muutmata.';
  if(code==='CANCELLED')return 'Ühendamine tühistati. Telefoni andmeid ei muudetud.';
  if(code==='CONNECTION_FAILED'||code==='TRANSPORT_ERROR'||code==='INCOMPLETE_REQUEST'||code==='INCOMPLETE_RESPONSE')return 'Ühendus katkes. Andmeid ei muudetud.';
  return 'Ühendust ei saanud luua. Kontrolli, et mõlemad telefonid oleksid samas Wi-Fi võrgus.';
}
function directBootstrapSummary(fileName,summary){
  return `<b>Fail:</b> ${esc(fileName||'DOLD TechControl.xlsx')}<br><b>Objekte:</b> ${Number(summary?.objectCount)||0}<br><b>Aktiivses kontrollis:</b> ${Number(summary?.activeCount)||0}<br><b>Avatud puudusi:</b> ${Number(summary?.openDefects)||0}<br><b>Kontroll:</b> ${Number(summary?.checkedCount)||0} / ${Number(summary?.activeCount)||0}`;
}
function showDirectDialog(title,body,actions=[{value:'done',label:'VALMIS',primary:true}]){
  return showAppChoice(title,body,actions);
}
function setDirectStatusScreen(title,body){
  const box=$('appDialog');if(!box)return;
  if(appDialogResolve)appDialogChoice('replace');
  $('appDialogTitle').textContent=title;$('appDialogBody').innerHTML=body;$('appDialogActions').innerHTML='';box.classList.remove('hidden');
}
function closeDirectStatusScreen(){const box=$('appDialog');if(box)box.classList.add('hidden');}
function startDirectSyncScanner(){
  if(!window.Android||typeof Android.scanQr!=='function'){showDirectDialog('QR-skanner pole saadaval','Kasuta paketiga sünkroonimist.');return;}
  S.qrMode='directSync';startQrScanner('directSync');
}
async function prepareDirectSyncSession(){
  if(!S.zip||!TC.dbId||!TC.sync)throw Error('Ava enne QR-sünkroonimist tööfail.');
  if(!window.Android||typeof Android.startLanSyncSession!=='function'||typeof Android.createLanSyncQrPngBase64!=='function')throw Error('Selles APK-s puudub otseühenduse tugi.');
  const baseline=await createSyncBaselineBytes();if(baseline.length>DIRECT_SYNC_MAX_BYTES)return {status:'PAYLOAD_TOO_LARGE'};
  const deferred=supportsR4DirectSync(),started=JSON.parse(deferred?Android.startLanSyncSessionDeferred(TC.dbId,bytesToBase64(baseline)):Android.startLanSyncSession(TC.dbId,bytesToBase64(baseline)));
  if(!started.ok||started.status!=='STARTED')return {status:started.status||'ERROR',message:started.message||''};
  try{
    const payload=directPairingPayload(started.pairing),qrBase64=Android.createLanSyncQrPngBase64(payload,640);
    if(!qrBase64)throw Error('QR-koodi loomine ebaõnnestus.');
    const archive=await JSZip.loadAsync(baseline,{checkCRC32:true}),mf=archive.file('manifest.json');if(!mf)throw Error('Baaspaketist puudub manifest.');
    const manifest=JSON.parse(await mf.async('string'));
    return {status:'STARTED',pairing:parseDirectSyncQr(payload),payload,qrBase64,manifest,baselineSize:baseline.length,baselineBase64:bytesToBase64(baseline),deferred};
  }catch(e){try{if(typeof Android.stopLanSyncSessionFor==='function'&&started.pairing?.sessionId)Android.stopLanSyncSessionFor(started.pairing.sessionId);else Android.stopLanSyncSession();}catch(ignore){}throw e;}
}
function cancelDirectSyncHost(){
  directHostGeneration++;try{if(window.Android&&typeof Android.stopLanSyncSession==='function')Android.stopLanSyncSession();}catch(e){}
  appDialogChoice('cancel');
}
function showDirectHostWaitDialog(session){
  $('appDialogTitle').textContent='TELEFONIDE SÜNKROONIMINE';
  $('appDialogBody').innerHTML=`<div class="syncQrWait"><div class="big">Ootan teist telefoni...</div><img class="syncQrImage" alt="Ajutine DOLD sünkroonimise QR-kood" src="data:image/png;base64,${session.qrBase64}"><div class="small">Sessioon aegub: <b id="directQrCountdown"></b></div><div class="small">Näita koodi teise telefoni DOLD TechControli kaamerale.</div></div>`;
  $('appDialogActions').innerHTML='<button onclick="cancelDirectSyncHost()">TÜHISTA</button>';$('appDialog').classList.remove('hidden');
  return new Promise(resolve=>{appDialogResolve=resolve;});
}
function updateDirectHostCountdown(expiresAt){
  const left=Math.max(0,Math.ceil((expiresAt-Date.now())/1000)),el=$('directQrCountdown');if(el)el.textContent=String(Math.floor(left/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0');
}
async function pollDirectHostSession(session,generation){
  while(generation===directHostGeneration){
    let info;try{info=JSON.parse(Android.getLanSyncSessionStatus());}catch(e){return {status:'ERROR'};}
    if(info.status==='COMPLETED'||info.status==='EXPIRED'||info.status==='CANCELLED'||info.status==='ERROR'||info.status==='STOPPED')return info;
    updateDirectHostCountdown(session.pairing.expiresAt);
    if(Date.now()>=session.pairing.expiresAt)return {status:'EXPIRED'};
    await new Promise(resolve=>setTimeout(resolve,700));
  }
  return {status:'CANCELLED'};
}
async function pollDirectHostEvent(session,generation){
  while(generation===directHostGeneration){
    let info;try{info=JSON.parse(Android.getLanSyncSessionStatus());}catch(e){return {status:'ERROR'};}
    if(['REQUEST_RECEIVED','ACK_RECEIVED','COMPLETED','EXPIRED','CANCELLED','ERROR','STOPPED'].includes(info.status))return info;
    updateDirectHostCountdown(session.pairing.expiresAt);
    if(Date.now()>=session.pairing.expiresAt)return {status:'EXPIRED'};
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  return {status:'CANCELLED'};
}
function hostRequestIsBootstrap(status,session){
  try{const request=JSON.parse(new TextDecoder().decode(decode64(status.requestBase64||'')));return request.format===DIRECT_SYNC_BOOTSTRAP_FORMAT&&request.version===1&&request.action==='REQUEST_BASELINE'&&request.lineage===session.pairing.lineage;}
  catch(e){return false;}
}
function directControlMessage(value){return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));}
function directControlFromBase64(value){try{return JSON.parse(new TextDecoder().decode(decode64(value||'')));}catch(e){return null;}}
async function respondDirectHost(session,payload,terminal){
  if(!session.deferred||!window.Android||typeof Android.respondLanSyncSession!=='function')return false;
  const bytes=payload instanceof Uint8Array?payload:new TextEncoder().encode(String(payload||''));if(bytes.length>DIRECT_SYNC_MAX_BYTES)return false;
  return !!Android.respondLanSyncSession(bytesToBase64(bytes),!!terminal);
}
async function runDirectSyncHostR4(session,generation){
  let prepared=null,hostDelta=null,hostDeltaHash='',peerDeviceId='';
  while(generation===directHostGeneration){
    const event=await pollDirectHostEvent(session,generation);if(event.status==='CANCELLED')return {status:'CANCELLED'};
    if(event.status==='EXPIRED')return {status:'EXPIRED'};
    if(event.status==='ERROR'||event.status==='STOPPED')return event;
    if(event.status==='COMPLETED')return {status:'COMPLETED',prepared,hostDeltaHash};
    const payload=decode64(event.requestBase64||'');
    if(event.status==='REQUEST_RECEIVED'){
      if(hostRequestIsBootstrap(event,session)){
        if(!await respondDirectHost(session,decode64(session.baselineBase64),true))return {status:'ERROR'};
        const completed=await pollDirectHostEvent(session,generation);return {status:completed.status,bootstrap:true};
      }
      try{
        prepared=await processSyncPackageBytes(payload,'DOLD_TELEFON_B_SÜNKROON.dtcs',null,{directProtocol:true,directPrepareOnly:true,directRole:'TELEFON B → TELEFON A'});
        if(!prepared?.accepted){const reject=directControlMessage({format:DIRECT_SYNC_COMMIT_FORMAT,version:1,phase:'SYNC_REJECTED',sessionId:session.pairing.sessionId,dbId:TC.dbId,epoch:TC.sync.epoch,reason:'USER_CANCELLED'});await respondDirectHost(session,decode64(reject),true);return {status:'CANCELLED'};}
        peerDeviceId=prepared.manifest.senderDeviceId||'';
        if(!peerDeviceId||peerDeviceId===TC.deviceId)throw Error('SAME_DEVICE');
        hostDelta=await createSyncDeltaBytes();if(hostDelta.length>DIRECT_SYNC_MAX_BYTES)throw Error('PAYLOAD_TOO_LARGE');hostDeltaHash=await digest(hostDelta);
        renderDirectHostWaitScreen(session,'Teise telefoniga saadetud kontrollid ja parandused kinnituse järel salvestatakse.');
        if(!await respondDirectHost(session,hostDelta,false))throw Error('CONNECTION_FAILED');
      }catch(e){
        const reason=e.message||'SYNC_REJECTED',reject=directControlMessage({format:DIRECT_SYNC_COMMIT_FORMAT,version:1,phase:'SYNC_REJECTED',sessionId:session.pairing.sessionId,dbId:TC.dbId,epoch:TC.sync.epoch,reason});
        await respondDirectHost(session,decode64(reject),true);return {status:'ERROR',error:reason};
      }
      continue;
    }
    if(event.status==='ACK_RECEIVED'){
      const control=directControlFromBase64(event.requestBase64);
      if(control?.format===DIRECT_SYNC_COMMIT_FORMAT&&control.version===1&&control.phase==='CLIENT_ABORT'
        &&control.sessionId===session.pairing.sessionId&&control.dbId===TC.dbId&&control.epoch===TC.sync.epoch){
        const aborted=directControlMessage({format:DIRECT_SYNC_COMMIT_FORMAT,version:1,phase:'SYNC_ABORTED',sessionId:session.pairing.sessionId,dbId:TC.dbId,epoch:TC.sync.epoch});
        await respondDirectHost(session,decode64(aborted),true);return {status:'CANCELLED'};
      }
      try{
        if(!prepared||!peerDeviceId)throw Error('SYNC_PROTOCOL_INVALID');
        const finalResult=await processSyncPackageBytes(payload,'DOLD_TELEFON_B_SÜNKROON.dtcs',null,{directProtocol:true,directApplyConfirmed:true,directRole:'TELEFON B → TELEFON A'});
        if(!finalResult?.accepted)throw Error('SYNC_REJECTED');
        if(finalResult.manifest.senderDeviceId!==peerDeviceId)throw Error('SYNC_PEER_CHANGED');
        const ack=directControlMessage({format:DIRECT_SYNC_COMMIT_FORMAT,version:1,phase:'SYNC_COMMITTED',sessionId:session.pairing.sessionId,dbId:TC.dbId,epoch:TC.sync.epoch,hostDeviceId:TC.deviceId,clientDeviceId:peerDeviceId,hostDeltaHash,clientDeltaHash:await digest(payload),hostApplied:finalResult.report?.applied||0,hostDuplicates:finalResult.report?.duplicates||0,completedAt:new Date().toISOString()});
        if(!await respondDirectHost(session,decode64(ack),true))throw Error('CONNECTION_FAILED');
        const completed=await pollDirectHostEvent(session,generation);if(completed.status!=='COMPLETED')return completed;
        return {status:'COMPLETED',prepared,hostDeltaHash,finalResult};
      }catch(e){
        const failed=directControlMessage({format:DIRECT_SYNC_COMMIT_FORMAT,version:1,phase:'SYNC_UNCONFIRMED',sessionId:session.pairing.sessionId,dbId:TC.dbId,epoch:TC.sync.epoch,reason:e.message||'SYNC_FAILED'});
        await respondDirectHost(session,decode64(failed),true);return {status:'ERROR',error:e.message||'SYNC_FAILED',prepared};
      }
    }
  }
  return {status:'CANCELLED'};
}
function renderDirectHostWaitScreen(session,message='Ootan teist telefoni...'){
  $('appDialogTitle').textContent='TELEFONIDE SÜNKROONIMINE';
  $('appDialogBody').innerHTML=`<div class="syncQrWait"><div class="big">${esc(message)}</div><img class="syncQrImage" alt="Ajutine DOLD sünkroonimise QR-kood" src="data:image/png;base64,${session.qrBase64}"><div class="small">Sessioon aegub: <b id="directQrCountdown"></b></div><div class="small">Näita koodi teise telefoni DOLD TechControli kaamerale.</div></div>`;
  $('appDialogActions').innerHTML='<button onclick="cancelDirectSyncHost()">TÜHISTA</button>';$('appDialog').classList.remove('hidden');updateDirectHostCountdown(session.pairing.expiresAt);
}
async function showDirectSyncQr(){
  if(TC.busy)return;if(!S.zip){await showDirectDialog('Aktiivne tööfail puudub','Ava kõigepealt DOLD TechControli XLSX tööfail.');return;}
  let session;setBusy(true);
  try{session=await prepareDirectSyncSession();}
  catch(e){setBusy(false);await showDirectDialog('QR-sünkroonimist ei saanud alustada',esc(e.message||String(e)));return;}
  finally{if(TC.busy)setBusy(false);}
  if(session.status!=='STARTED'){
    const noNetwork=session.status==='NO_LOCAL_NETWORK'||session.status==='BIND_FAILED';
    const message=noNetwork?'Kohalik võrk pole saadaval. Mõlemad telefonid peavad olema samas Wi-Fi / LAN võrgus.':session.status==='PAYLOAD_TOO_LARGE'?directSyncErrorText('PAYLOAD_TOO_LARGE'):'Ajutist ühendust ei saanud avada.';
    const actions=noNetwork||session.status==='PAYLOAD_TOO_LARGE'?[{value:'package',label:'KASUTA PAKETIGA SÜNKROONIMIST',primary:true},{value:'cancel',label:'TÜHISTA'}]:[{value:'done',label:'VALMIS',primary:true}];
    const choice=await showDirectDialog(noNetwork?'Kohalik võrk pole saadaval':'QR-sünkroonimist ei saanud alustada',esc(message),actions);if(choice==='package')await shareSyncBaseline();return;
  }
  if(session.deferred){
    const generation=++directHostGeneration;let result;
    try{renderDirectHostWaitScreen(session);result=await runDirectSyncHostR4(session,generation);}
    catch(e){result={status:'ERROR',error:e.message||String(e)};}
    finally{
      try{if(window.Android&&typeof Android.stopLanSyncSessionFor==='function')Android.stopLanSyncSessionFor(session.pairing.sessionId);}catch(e){}
      closeDirectStatusScreen();
    }
    if(result.bootstrap&&result.status==='COMPLETED')await showDirectDialog('ÜHENDATUD',`Baaspakett saadeti teise telefoni.<div class="topgap">Telefonis <b>${esc(session.manifest.fileName||'DOLD TechControl.xlsx')}</b> oodatakse enne salvestamist kasutaja kinnitust.</div>`,[{value:'done',label:'VALMIS',primary:true}]);
    else if(result.status==='COMPLETED')await showAppChoice('SÜNKROONITUD',`Saadud:<br>${directSyncSummaryHtml(result.prepared?.sum||{})}<div class="topgap">Telefoni enda muudatused säilitati.<br>Mõlema telefoni salvestus kinnitati.</div>`,[{value:'done',label:'VALMIS',primary:true}]);
    else if(result.status==='EXPIRED')await showDirectDialog('SESSIOON AEGUS','QR-kood on aegunud. Loo uus QR.');
    else if(result.status==='ERROR')await showDirectDialog('SÜNKROONIMISE TULEMUST EI SAANUD KINNITADA','Ühenda telefonid uuesti. Telefoni kohalik töö jäi alles.');
    return;
  }
  const generation=++directHostGeneration,dialog=showDirectHostWaitDialog(session),monitor=pollDirectHostSession(session,generation);
  const result=await Promise.race([dialog.then(choice=>({choice})),monitor.then(status=>({status}))]);
  if(result.choice==='cancel')return;
  if(result.status){appDialogChoice('finished');
    if(result.status.status==='COMPLETED'&&hostRequestIsBootstrap(result.status,session)){
      await showDirectDialog('ÜHENDATUD',`Baaspakett saadeti teise telefoni.<div class="topgap">Telefonis <b>${esc(session.manifest.fileName||'DOLD TechControl.xlsx')}</b> oodatakse enne salvestamist kasutaja kinnitust.</div>`,[{value:'done',label:'VALMIS',primary:true}]);
    }else if(result.status.status==='EXPIRED'){
      const choice=await showDirectDialog('SESSIOON AEGUS','QR-kood on aegunud. Loo uus QR.',[{value:'retry',label:'LOO UUS QR',primary:true},{value:'done',label:'VALMIS'}]);if(choice==='retry')showDirectSyncQr();
    }else if(result.status.status!=='CANCELLED'){
      const choice=await showDirectDialog('ÜHENDUS KATKES','Andmeid ei muudetud. Kontrolli Wi-Fi ühendust ja proovi uuesti.',[{value:'retry',label:'LOO UUS QR',primary:true},{value:'done',label:'VALMIS'}]);if(choice==='retry')showDirectSyncQr();
    }
  }
}
async function findExistingDirectDatabase(){
  await TC.startupTask;
  if(TC.dbId)return {dbId:TC.dbId,fileName:S.fileName||TC.startupSnapshot?.fileName||''};
  const saved=await storeCall('list');if(!Array.isArray(saved)||!saved.length)return null;
  const latest=[...saved].sort((a,b)=>(Date.parse(b.lastUsedAt||b.updatedAt||'')||0)-(Date.parse(a.lastUsedAt||a.updatedAt||'')||0))[0];
  return latest?.dbId?{dbId:latest.dbId,fileName:latest.fileName||''}:null;
}
async function validateDirectBaselineBytes(bytes,pairing){
  if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes||[]);if(!bytes.length||bytes.length>DIRECT_SYNC_MAX_BYTES)throw Error('PAYLOAD_TOO_LARGE');
  const archive=await JSZip.loadAsync(bytes,{checkCRC32:true}),mf=archive.file('manifest.json');if(!mf)throw Error('PACKAGE_INVALID');
  const manifest=JSON.parse(await mf.async('string'));
  if(manifest.format!==SYNC_PACKAGE_FORMAT||manifest.version!==1||manifest.mode!=='baseline'||!manifest.dbId||!manifest.epoch)throw Error('PACKAGE_INVALID');
  if(await digest(new TextEncoder().encode(String(manifest.dbId)))!==pairing.lineage)throw Error('LINEAGE_MISMATCH');
  const stateFile=archive.file(manifest.state?.path||'state.json'),workbookFile=archive.file(manifest.workbook?.path||'workbook.xlsx');
  if(!stateFile||!workbookFile||!Number.isFinite(Number(manifest.state?.size))||!Number.isFinite(Number(manifest.workbook?.size))||Number(manifest.state.size)>DIRECT_SYNC_MAX_BYTES||Number(manifest.workbook.size)>DIRECT_SYNC_MAX_BYTES)throw Error('PACKAGE_INVALID');
  const stateBytes=await stateFile.async('uint8array'),workbookBytes=await workbookFile.async('uint8array');
  if(stateBytes.length!==manifest.state.size||workbookBytes.length!==manifest.workbook.size||await digest(stateBytes)!==manifest.state.sha256||await digest(workbookBytes)!==manifest.workbook.sha256)throw Error('INTEGRITY_FAILURE');
  return {manifest,archive};
}
async function waitDirectClientJob(jobId,expiresAt){
  while(Date.now()<=expiresAt+15000){
    let result;try{result=JSON.parse(Android.getLanSyncClientResult(jobId));}catch(e){throw Error('CONNECTION_FAILED');}
    if(result.status==='DONE')return result;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw Error('TIMEOUT');
}
async function directClientExchange(pairing,expectedDbId,payload){
  let start;try{start=JSON.parse(Android.startLanSyncClient(JSON.stringify(pairing),expectedDbId||'',bytesToBase64(payload)));}catch(e){throw Error('CONNECTION_FAILED');}
  if(!start.ok||!start.jobId)throw Error(start.status||'CONNECTION_FAILED');
  const result=await waitDirectClientJob(start.jobId,pairing.expiresAt);if(result.result!=='SUCCESS')throw Error(result.result||'CONNECTION_FAILED');
  return decode64(result.responseBase64||'');
}
function validateDirectSyncCommitAck(bytes,pairing,expected){
  const message=directControlFromBase64(bytesToBase64(bytes));
  if(!message||message.format!==DIRECT_SYNC_COMMIT_FORMAT||message.version!==1)throw Error('COMMIT_UNCONFIRMED');
  if(message.phase==='SYNC_REJECTED')throw Error(message.reason||'SYNC_REJECTED');
  if(message.phase==='SYNC_ABORTED')throw Error('SYNC_ABORTED');
  if(message.phase!=='SYNC_COMMITTED'||message.sessionId!==pairing.sessionId||message.dbId!==expected.dbId||message.epoch!==expected.epoch
    ||message.hostDeviceId!==expected.hostDeviceId||message.clientDeviceId!==expected.clientDeviceId
    ||message.hostDeltaHash!==expected.hostDeltaHash||message.clientDeltaHash!==expected.clientDeltaHash)throw Error('COMMIT_UNCONFIRMED');
  return message;
}
async function handleDirectSyncQr(raw){
  let localR4Committed=false;
  let pairing;try{pairing=parseDirectSyncQr(raw);}catch(e){if(S.qrMode==='directSync')S.qrMode='audit';const msg=e.message==='QR_EXPIRED'?directSyncErrorText('QR_EXPIRED'):e.message==='NOT_DOLD_SYNC_QR'?'See ei ole DOLD sünkroonimise QR-kood.':'DOLD sünkroonimise QR-kood on vigane.';await showDirectDialog('QR-KOODI EI SAA KASUTADA',msg);return false;}
  try{
    const local=await findExistingDirectDatabase();
    if(local){const localLineage=await digest(new TextEncoder().encode(String(local.dbId||'')));
      if(localLineage!==pairing.lineage){await showDirectDialog('TEINE TÖÖBAAS','Telefonides on erinevad DOLD tööbaasid. Andmeid ei muudetud.');return false;}
      if(!supportsR4DirectSync()){await showDirectDialog('TELEFON ON JUBA SEADISTATUD','Sama tööbaas on selles telefonis olemas. Kasuta paketiga sünkroonimist.');return false;}
      if(!S.zip||!TC.dbId||!TC.sync||TC.dbId!==local.dbId)throw Error('Ava esmalt selles telefonis sama aktiivne tööfail.');
      if(!window.Android||typeof Android.startLanSyncClient!=='function'||typeof Android.getLanSyncClientResult!=='function')throw Error('CONNECTION_FAILED');
      setDirectStatusScreen('ÜHENDAMINE...','Vahetan mõlema telefoni muudatused. Ühtegi muudatust ei rakendata enne kokkuvõtte ja kinnituse kuvamist.');
      let firstDelta;setBusy(true);try{firstDelta=await createSyncDeltaBytes();}finally{setBusy(false);}
      if(firstDelta.length>DIRECT_SYNC_MAX_BYTES)throw Error('PAYLOAD_TOO_LARGE');
      const hostBytes=await directClientExchange(pairing,TC.dbId,firstDelta),hostDeltaHash=await digest(hostBytes);
      const hostControl=directControlFromBase64(bytesToBase64(hostBytes));
      if(hostControl?.format===DIRECT_SYNC_COMMIT_FORMAT&&hostControl.phase==='SYNC_REJECTED')throw Error(hostControl.reason||'SYNC_REJECTED');
      if(hostControl?.format===DIRECT_SYNC_COMMIT_FORMAT)throw Error(hostControl.reason||'SYNC_REJECTED');
      closeDirectStatusScreen();
      const received=await processSyncPackageBytes(hostBytes,'DOLD_TELEFON_A_SÜNKROON.dtcs',null,{directProtocol:true,directRole:'TELEFON A → TELEFON B'});
      if(!received?.accepted){
        setBusy(true);const abort=directControlMessage({format:DIRECT_SYNC_COMMIT_FORMAT,version:1,phase:'CLIENT_ABORT',sessionId:pairing.sessionId,dbId:TC.dbId,epoch:TC.sync.epoch,deviceId:TC.deviceId});
        try{await directClientExchange(pairing,TC.dbId,decode64(abort));}catch(e){}finally{setBusy(false);}
        return false;
      }
      localR4Committed=true;
      setDirectStatusScreen('SÜNKROONIMINE...','Sinu muudatused salvestati. Kinnitan teise telefoni salvestuse.');setBusy(true);
      const clientFinalDelta=await createSyncDeltaBytes();if(clientFinalDelta.length>DIRECT_SYNC_MAX_BYTES)throw Error('PAYLOAD_TOO_LARGE');const clientDeltaHash=await digest(clientFinalDelta);
      const ackBytes=await directClientExchange(pairing,TC.dbId,clientFinalDelta);setBusy(false);closeDirectStatusScreen();
      const ack=validateDirectSyncCommitAck(ackBytes,pairing,{dbId:TC.dbId,epoch:TC.sync.epoch,hostDeviceId:received.manifest.senderDeviceId,clientDeviceId:TC.deviceId,hostDeltaHash,clientDeltaHash});
      await showAppChoice('SÜNKROONITUD',`Saadud:<br>${directSyncSummaryHtml(received.sum||{})}<div class="topgap">Telefoni enda muudatused säilitati.<br>Mõlema telefoni salvestus kinnitati.</div>`,[{value:'done',label:'VALMIS',primary:true}]);renderSyncStatus();return !!ack;
    }
    if(!window.Android||typeof Android.startLanSyncClient!=='function'||typeof Android.getLanSyncClientResult!=='function')throw Error('CONNECTION_FAILED');
    let localDeviceId=installationDeviceId();TC.deviceId=localDeviceId;
    const request=bytesToBase64(new TextEncoder().encode(JSON.stringify({format:DIRECT_SYNC_BOOTSTRAP_FORMAT,version:1,action:'REQUEST_BASELINE',lineage:pairing.lineage})));
    setDirectStatusScreen('ÜHENDAMINE...','Ootan teise telefoni vastust. Tööbaas laaditakse alles pärast kontrolli ja kinnitust.');setBusy(true);
    let start;try{start=JSON.parse(Android.startLanSyncClient(JSON.stringify(pairing),'',request));}catch(e){throw Error('CONNECTION_FAILED');}
    if(!start.ok||!start.jobId)throw Error(start.status||'CONNECTION_FAILED');
    const result=await waitDirectClientJob(start.jobId,pairing.expiresAt);
    if(result.result!=='SUCCESS')throw Error(result.result||'CONNECTION_FAILED');
    const bytes=decode64(result.responseBase64||''),checked=await validateDirectBaselineBytes(bytes,pairing);
    if(checked.manifest.senderDeviceId===localDeviceId){localDeviceId='device-'+uid();try{localStorage.setItem('dold_techcontrol_device_id_v1',localDeviceId);}catch(e){}TC.deviceId=localDeviceId;}
    closeDirectStatusScreen();setBusy(false);
    await processSyncPackageBytes(bytes,checked.manifest.fileName||'DOLD_Teise_telefoni_baas.dtcs',null,{directBootstrap:true,expectedLineage:pairing.lineage,localDeviceId});
    if(TC.dbId===checked.manifest.dbId)TC.deviceId=localDeviceId;
    return TC.dbId===checked.manifest.dbId;
  }catch(e){closeDirectStatusScreen();if(TC.busy)setBusy(false);const code=e.message||'CONNECTION_FAILED';
    const msg=localR4Committed?'Sünkroonimise tulemust ei saanud kinnitada. Ühenda telefonid uuesti; telefoni salvestatud töö jäi alles.':code==='PACKAGE_INVALID'?'Saadud tööbaasipakett on vigane. Telefoni andmeid ei muudetud.':code==='COMMIT_UNCONFIRMED'?'Sünkroonimise tulemust ei saanud kinnitada. Ühenda telefonid uuesti; salvestatud töö jääb alles.':code==='SYNC_REJECTED'||code==='USER_CANCELLED'?'Teine telefon ei kinnitanud sünkroonimist. Kohalikku tööbaasi ei asendatud.':code==='SYNC_ABORTED'?'Sünkroonimine tühistati. Telefoni senine töö jäi alles.':directSyncErrorText(code);
    await showDirectDialog('OTSEÜHENDUS EBAÕNNESTUS',msg);return false;
  }finally{if(S.qrMode==='directSync')S.qrMode='audit';}
}
function receiveSyncPackage(){selectNewWorkbook();}
function previewSyncOperations(operations){
  const saved=TC.sync,counts={newControls:0,newDefects:0,repairedDefects:0,updatedDefects:0,cabinetStatusChanges:0,otherChanges:0,newOperations:0,duplicates:0,conflicts:0,conflictItems:[]};
  TC.sync=cloneData(saved);
  const priorConflictIds=new Set(saved.conflicts.map(c=>c.conflictId));
  try{for(const op of operations){const plan=planSyncOperation(op);if(plan.duplicate){counts.duplicates++;continue;}counts.newOperations++;if(op.action==='ADD_KONTROLL')counts.newControls++;else if(op.action==='ADD_PUUDUS')counts.newDefects++;else if(op.action==='CLOSE_PUUDUS')counts.repairedDefects++;else if(op.entityType==='Puudus')counts.updatedDefects++;else if(op.entityType==='Cabinet')counts.cabinetStatusChanges++;else counts.otherChanges++;commitSyncOperation(op,plan);}
    counts.conflictItems=TC.sync.conflicts.filter(c=>!c.resolved&&!priorConflictIds.has(c.conflictId));counts.conflicts=counts.conflictItems.length;
  }
  finally{TC.sync=saved;}
  return counts;
}
function directSyncSummaryHtml(s){return `+ ${Number(s.newControls)||0} kontrolli<br>+ ${Number(s.newDefects)||0} uut puudust<br>${Number(s.repairedDefects)||0} parandust<br>${Number(s.updatedDefects)||0} uuendatud puudust<br>${Number(s.cabinetStatusChanges)||0} kilbi staatuse muudatust<br>${Number(s.otherChanges)||0} muud muudatust`;}
function directSyncPreviewBody(direction,summary,preview){return `<b>${esc(direction)}</b><div class="topgap">${directSyncSummaryHtml(summary)}</div><div class="topgap"><b>Selles telefonis:</b><br>${localPendingSyncCount()} saatmata muudatust</div><div class="topgap"><b>Uusi / uuendatud toiminguid:</b> ${preview.newOperations}<br><b>Vastuolusid:</b> ${preview.conflicts}<br><b>Juba olemas:</b> ${preview.duplicates}</div>`;}
async function importSyncBaseline(archive,manifest,file,options={}){
  if(TC.dbId&&S.zip)throw Error('See telefon on juba tööfailiga ette valmistatud. Jätka selle tööga või kasuta tavapärast töö üleandmist.');
  const stateFile=archive.file(manifest.state?.path||'state.json'),workbookFile=archive.file(manifest.workbook?.path||'workbook.xlsx');if(!stateFile||!workbookFile)throw Error('Baaspaketist puudub töövihik või oleku fail.');
  const stateBytes=await stateFile.async('uint8array'),workbookBytes=await workbookFile.async('uint8array');
  if(stateBytes.length!==manifest.state.size||await digest(stateBytes)!==manifest.state.sha256)throw Error('Baaspaketi oleku kontrollsumma ei klapi.');
  if(workbookBytes.length!==manifest.workbook.size||await digest(workbookBytes)!==manifest.workbook.sha256)throw Error('Baaspaketi XLSX kontrollsumma ei klapi.');
  const state=JSON.parse(new TextDecoder().decode(stateBytes));if(state.schema!==1||!state.dbId||state.dbId!==manifest.dbId||!state.sync||state.sync.schema!==1||state.sync.dbId!==state.dbId||state.sync.epoch!==manifest.epoch)throw Error('Baaspaketi andmebaasi tunnus või sünkroonimise algseis ei klapi.');
  if(options.directBootstrap){
    const incomingLineage=await digest(new TextEncoder().encode(String(manifest.dbId)));
    if(incomingLineage!==options.expectedLineage)throw Error('Telefonid ei kasuta sama tööbaasi.');
    if(!options.localDeviceId||options.localDeviceId===manifest.senderDeviceId)throw Error('Telefoni seadme tunnus peab lähtetelefonist erinema.');
  }
  if(state.workbookHash!==manifest.workbook.sha256)throw Error('Baaspaketi olek viitab teisele XLSX töövihikule.');
  const cycleIds=Object.keys(state.cycle?.entries||{}).sort(),checkedIds=(state.checkedIds||cycleIds).slice().sort();if(cycleIds.length!==checkedIds.length||cycleIds.some((id,i)=>id!==checkedIds[i]))throw Error('Baaspaketi kontrolli edenemise ID-d ei klapi.');
  const incomingSummary=await summarizeWorkbookBytes(workbookBytes,state.fileName||manifest.fileName||file.name,state.cycle,{updatedAt:state.updatedAt,revision:state.revision});
  for(const key of ['controlCount','defectCount','openDefects','activeCount','checkedCount'])if(Number(incomingSummary[key])!==Number(state.summary?.[key]))throw Error('Baaspaketi kokkuvõte ei klapi töövihikuga ('+key+').');
  const preview=options.directBootstrap
    ?`${directBootstrapSummary(state.fileName||manifest.fileName||file.name,incomingSummary)}<p class="topgap"><b>Kontrolli ajalugu ja avatud puudused kopeeritakse samuti.</b></p><p class="topgap">Telefon saab sama tööbaasi ja sünkroonimise algseisu. Seadme tunnus jääb sellele telefonile eraldi.</p>`
    :`Seade saab sama dbId ja sünkroonimise algseisu. Selle telefoni deviceId jääb eraldi.<div class="topgap">${summaryBlock('SAABUV BAAS',incomingSummary)}</div><p class="topgap">Pärast seda saab mõlemas telefonis paralleelselt töötada ja muudatusi vahetada.</p>`;
  const choice=await showAppChoice(options.directBootstrap?'UUS TELEFON':'VALMISTA TEINE TELEFON',preview,[{value:'initialize',label:options.directBootstrap?'VALMISTA SEE TELEFON ETTE':'VALMISTA ETTE',primary:true},{value:'cancel',label:'TÜHISTA'}]);
  if(choice!=='initialize')return;
  const snapshot={schema:1,dbId:state.dbId,fileName:state.fileName||manifest.fileName||file.name,registryKey:state.registryKey||'',registryTokens:state.registryTokens||[],cycle:state.cycle||null,sync:state.sync,signatureVersions:normalizeSignatureVersionMap(state.signatureVersions),guard:{remaining:randomGap(),pending:null},revision:Number(state.revision)||0,updatedAt:state.updatedAt||manifest.createdAt,lastUsedAt:new Date().toISOString(),sourceHash:state.sourceHash||manifest.workbook.sha256,baseWorkbookBase64:bytesToBase64(workbookBytes),inspector:state.inspector||'',dirty:!!state.dirty,workbookHash:manifest.workbook.sha256,summary:incomingSummary,workbookBase64:bytesToBase64(workbookBytes)};
  await storeCall('put',snapshot);Object.assign(TC,{dbId:snapshot.dbId,registryKey:snapshot.registryKey,registryTokens:snapshot.registryTokens,cycle:snapshot.cycle,sync:snapshot.sync,signatureVersions:snapshot.signatureVersions,guard:snapshot.guard,revision:snapshot.revision,updatedAt:snapshot.updatedAt,localUsedAt:snapshot.lastUsedAt,sourceHash:snapshot.sourceHash,baseWorkbookBase64:snapshot.baseWorkbookBase64,ready:false,opened:null,pending:{notice:'Teise telefoni baastöö vastu võetud.'}});
  S.inspector=snapshot.inspector;S.dirty=snapshot.dirty;S.stagedDefects=[];await loadBook(workbookBytes,snapshot.fileName);TC.startupLoaded=true;TC.startupSnapshot=snapshot;TC.startupError='';TC.startupWarning='';TC.activated=true;
  $('workTabs').classList.remove('hidden');$('exportBtn').disabled=false;$('shareXlsxBtn').disabled=false;$('sharePackageBtn').disabled=false;$('workbookImportCard').classList.add('hidden');loadMinInspectionSetting();if(!options.directBootstrap)await persistWorkspace();renderStartupWorkspace();renderCyclePanel();showTab('home');
  if(options.directBootstrap)await showAppChoice('TELEFON ON VALMIS',`${directBootstrapSummary(snapshot.fileName,incomingSummary)}<p class="topgap">Sama tööbaas on salvestatud. Sellel telefonil on eraldi seadme tunnus.</p>`,[{value:'done',label:'VALMIS',primary:true}]);else toast('Telefon on paralleelseks tööks ette valmistatud',4500);
}
// File Share and future transports pass package bytes through this single semantic sync path.
async function processSyncPackageBytes(sourceBytes,fileName='sync.dtcs',clearInput=null,options={}){
  const file={name:fileName};let markedBusy=false;
  try{
    if(TC.startupTask)await TC.startupTask;if(!sourceBytes||TC.busy)return;setBusy(true);markedBusy=true;
    const bytes=new Uint8Array(sourceBytes),archive=await JSZip.loadAsync(bytes,{checkCRC32:true}),mf=archive.file('manifest.json');if(!mf)throw Error('Sünkroonimispaketist puudub manifest.');
    const manifest=JSON.parse(await mf.async('string'));if(manifest.format!==SYNC_PACKAGE_FORMAT||manifest.version!==1||!['baseline','delta'].includes(manifest.mode))throw Error('Seda sünkroonimispaketi versiooni ei toetata.');
    if(manifest.mode==='baseline'){await importSyncBaseline(archive,manifest,file,options);return;}
    if(!TC.dbId||!TC.sync||!S.zip)throw Error('Ava esmalt sama andmebaasi tööfail või valmista telefon baaspaketiga ette.');
    if(manifest.dbId!==TC.dbId)throw Error('Need tööfailid ei kuulu samasse andmebaasi.');
    if(manifest.epoch!==TC.sync.epoch)throw Error('Sünkroonimispakett kuulub teise tööbaasi algseisu. Valmista teine telefon uuesti ette.');
    const opFile=archive.file(manifest.operations?.path||'operations.json');if(!opFile)throw Error('Sünkroonimispaketist puuduvad muudatused.');
    const opBytes=await opFile.async('uint8array');if(opBytes.length!==manifest.operations.size||await digest(opBytes)!==manifest.operations.sha256)throw Error('Sünkroonimispaketi kontrollsumma ei klapi.');
    const operations=JSON.parse(new TextDecoder().decode(opBytes));if(!Array.isArray(operations)||operations.length!==manifest.operations.count)throw Error('Sünkroonimispaketi muudatuste loend on vigane.');
    const preview=previewSyncOperations(operations),sum={newControls:preview.newControls,newDefects:preview.newDefects,repairedDefects:preview.repairedDefects,updatedDefects:preview.updatedDefects,cabinetStatusChanges:preview.cabinetStatusChanges,otherChanges:preview.otherChanges};
    let choice='sync';
    if(options.directPrepareOnly||options.directProtocol&&!options.directApplyConfirmed){
      const direction=options.directRole||'TEISEST TELEFONIST';
      choice=await showAppChoice('SÜNKROONIMINE',directSyncPreviewBody(direction,sum,preview),[{value:'sync',label:preview.conflicts?'SÜNKROONI JA LAHENDA VASTUOLUD':'SÜNKROONI',primary:true},{value:'cancel',label:'TÜHISTA'}]);
      if(choice!=='sync')return {accepted:false,manifest,operations,preview,sum};
    }else if(!options.directApplyConfirmed){
      const body=`<b>TEISEST TELEFONIST:</b><div class="topgap">${syncSummaryHtml(sum)}</div><div class="topgap"><b>SELLES TELEFONIS:</b><br>${localPendingSyncCount()} saatmata muudatust</div><div class="topgap"><b>Lisandub või uueneb:</b> ${preview.newOperations}<br><b>Vastuolusid:</b> ${preview.conflicts}<br><b>Juba olemas:</b> ${preview.duplicates}</div>`;
      choice=await showAppChoice('SÜNKROONIMINE',body,[{value:'sync',label:preview.conflicts?'SÜNKROONI JA LAHENDA VASTUOLUD':'SÜNKROONI',primary:true},{value:'cancel',label:'TÜHISTA'}]);
      if(choice!=='sync')return {accepted:false,manifest,operations,preview,sum};
    }
    if(options.directPrepareOnly)return {accepted:true,manifest,operations,preview,sum};
    const conflictChoices={};if(options.directProtocol&&preview.conflictItems.length){setBusy(false);for(const conflict of preview.conflictItems){const pick=await promptSyncConflict(conflict);if(!['local','remote'].includes(pick))return {accepted:false,manifest,operations,preview,sum};conflictChoices[conflict.conflictId]=pick;}setBusy(true);}
    setBusy(false);const report=await applySyncOperations(operations,manifest.senderDeviceId||'',options.directProtocol?conflictChoices:null);if(report.conflicts&&!options.directProtocol)await resolvePendingSyncConflicts(conflictChoices);
    if(options.directProtocol||options.directApplyConfirmed){renderSyncStatus();return {accepted:true,manifest,operations,preview,sum,report};}
    await showAppChoice('SÜNKROONITUD',`Saadud:<br>${syncSummaryHtml(sum)}<div class="topgap">Telefoni enda muudatused säilitati.<br>Rakendatud: ${report.applied} • Juba olemas: ${report.duplicates} • Vastuolusid lahendati: ${report.conflicts}</div>`,[{value:'done',label:'JÄTKA',primary:true}]);
    renderSyncStatus();return {accepted:true,manifest,operations,preview,sum,report};
  }catch(e){if(options.directBootstrap||options.directProtocol)throw e;alert('Sünkroonimine ebaõnnestus. Telefoni senine töö jäi alles.\n'+e.message);}
  finally{if(markedBusy)setBusy(false);clearInput?.();}
}
async function importSyncPackage(ev,sourceBytes=null){
  const file=ev.target.files?.[0];if(!file)return;
  try{const bytes=sourceBytes?new Uint8Array(sourceBytes):new Uint8Array(await file.arrayBuffer());return await processSyncPackageBytes(bytes,file.name,()=>{ev.target.value='';});}
  catch(e){alert('Sünkroonimine ebaõnnestus. Telefoni senine töö jäi alles.\n'+(e.message||String(e)));ev.target.value='';}
}
function receiveWorkPackage(){selectNewWorkbook();}
async function importWorkPackage(ev,sourceBytes=null){
  if(TC.startupTask)await TC.startupTask;const file=ev.target.files?.[0];if(!file||TC.busy)return;setBusy(true);
  try{
    const packageBytes=sourceBytes?new Uint8Array(sourceBytes):new Uint8Array(await file.arrayBuffer()),archive=await JSZip.loadAsync(packageBytes,{checkCRC32:true});
    const manifestFile=archive.file('manifest.json'),stateFile=archive.file('state.json');if(!manifestFile||!stateFile)throw Error('Tööpaketis puudub manifest või rakenduse olek.');
    const manifest=JSON.parse(await manifestFile.async('string')),stateBytes=await stateFile.async('uint8array');
    if(manifest.format!==WORK_PACKAGE_FORMAT||manifest.version!==1)throw Error('Seda DOLD tööpaketi versiooni ei toetata.');
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
    const snapshot={schema:1,dbId:state.dbId,fileName:state.fileName||manifest.fileName||'DOLD_TechControl.xlsx',registryKey:state.registryKey||'',registryTokens:state.registryTokens||[],cycle:state.cycle||null,sync:state.sync||null,signatureVersions:normalizeSignatureVersionMap(state.signatureVersions),guard:state.guard||{remaining:randomGap(),pending:null},revision:Number(state.revision)||0,updatedAt:state.updatedAt||manifest.createdAt,lastUsedAt:new Date().toISOString(),sourceHash:state.sourceHash||manifest.workbook.sha256,baseWorkbookBase64:baseBytes?bytesToBase64(baseBytes):'',inspector:state.inspector||'',dirty:!!state.dirty,workbookHash:manifest.workbook.sha256,summary:incomingSummary,workbookBase64:bytesToBase64(workbookBytes)};
    await storeCall('put',snapshot);
    Object.assign(TC,{dbId:snapshot.dbId,registryKey:snapshot.registryKey,registryTokens:snapshot.registryTokens,cycle:snapshot.cycle,sync:snapshot.sync,signatureVersions:snapshot.signatureVersions,guard:snapshot.guard,revision:snapshot.revision,updatedAt:snapshot.updatedAt,localUsedAt:snapshot.lastUsedAt,sourceHash:snapshot.sourceHash,baseWorkbookBase64:snapshot.baseWorkbookBase64,ready:false,opened:null,pending:{notice:'Teiselt telefonilt vastu võetud tööpakett.'}});
    S.inspector=snapshot.inspector;S.dirty=snapshot.dirty;S.stagedDefects=[];await loadBook(workbookBytes,snapshot.fileName);TC.startupLoaded=true;TC.startupSnapshot=snapshot;TC.startupError='';TC.startupWarning='';TC.activated=true;TC.ready=false;
    $('workTabs').classList.remove('hidden');$('exportBtn').disabled=false;$('shareXlsxBtn').disabled=false;$('sharePackageBtn').disabled=false;$('workbookImportCard').classList.add('hidden');loadMinInspectionSetting();renderStartupWorkspace();renderCyclePanel();showTab('home');toast('Tööpakett vastu võetud. Puudused ja parandused on avatud.',4500);
  }catch(e){alert('Tööpaketi vastuvõtt ebaõnnestus. Telefoni eelmine töö jäi alles.\n'+e.message);}
  finally{setBusy(false);ev.target.value='';}
}
async function onNativeExportFinished(ok,message){TC.exportPending=false;if(ok){const alreadyBusy=TC.busy;setBusy(true);S.dirty=false;try{await persistWorkspace();renderCyclePanel();}catch(e){S.dirty=true;alert('Koopia eksporditud, kuid ekspordioleku salvestamine ebaõnnestus. Kontroll jäi alles.\n'+e.message);}finally{if(!alreadyBusy)setBusy(false);}toast(message||'XLSX koopia salvestatud',4000);}else alert((message||'Eksport tühistatud')+'\nTelefonis salvestatud kontroll jäi alles.');}
loadMinInspectionSetting();applyTheme();try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTheme);}catch(e){}
TC.startupTask=bootstrapSavedWorkspace();
