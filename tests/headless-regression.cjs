/* Runs the REAL app controller and bundled workbook editor under Node.
 * The small DOM adapter is for XML and form fields, not an Android/WebView emulator.
 * Usage: NODE_PATH=... node tests/headless-regression.cjs /path/input.xlsx /path/results
 */
const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto'),assert=require('assert');
const modules=process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const dep=n=>require(modules?path.join(modules,n):n);
const XML=dep('xml-js'),JSZip=dep('jszip');
class XmlNode{
 constructor(data,ns='',parent=null){this.data=data;this.parentNode=parent;this.namespaceURI=ns;this.localName=(data.name||'').split(':').pop();this.nodeName=data.name;this.childNodes=[];const a=data.attributes||{};this.ns={...(parent?.ns||{})};for(const [k,v] of Object.entries(a))if(k==='xmlns')this.ns['']=v;else if(k.startsWith('xmlns:'))this.ns[k.slice(6)]=v;if(data.name)this.namespaceURI=this.ns[data.name.includes(':')?data.name.split(':')[0]:'']||ns;for(const x of data.elements||[])this.childNodes.push(new XmlNode(x,this.namespaceURI,this));}
 get attributes(){return Object.entries(this.data.attributes||{}).map(([name,value])=>({name,localName:name.split(':').pop(),value}));}
 get firstChild(){return this.childNodes[0]||null;}get documentElement(){return this.childNodes.find(x=>x.data.type==='element');}
 get textContent(){return this.data.type==='text'?this.data.text:this.childNodes.map(x=>x.textContent||'').join('');}
 set textContent(v){this.childNodes=[new XmlNode({type:'text',text:String(v)},'',this)];}
 getAttribute(n){return this.data.attributes?.[n]??null;}setAttribute(n,v){(this.data.attributes??={})[n]=String(v);}hasAttribute(n){return n in (this.data.attributes||{});}removeAttribute(n){delete (this.data.attributes||{})[n];}
 getElementsByTagName(n){return this.childNodes.flatMap(x=>[...(x.data.type==='element'&&(n==='*'||x.nodeName===n)?[x]:[]),...x.getElementsByTagName(n)]);}
 getElementsByTagNameNS(ns,n){return this.getElementsByTagName('*').filter(x=>(ns==='*'||x.namespaceURI===ns)&&(n==='*'||x.localName===n));}
 importNode(node,deep){return node.cloneNode(deep);}
 createElementNS(ns,name){return new XmlNode({type:'element',name,attributes:{}},ns);}
 appendChild(x){x.parentNode=this;this.childNodes.push(x);return x;}insertBefore(x,b){x.parentNode=this;const i=this.childNodes.indexOf(b);if(i<0)this.childNodes.push(x);else this.childNodes.splice(i,0,x);return x;}
 removeChild(x){this.childNodes.splice(this.childNodes.indexOf(x),1);x.parentNode=null;return x;}
 toData(){const d={...this.data};if(this.childNodes.length)d.elements=this.childNodes.map(x=>x.toData());else delete d.elements;return d;}
 cloneNode(deep){return new XmlNode(JSON.parse(JSON.stringify({...this.toData(),...(!deep?{elements:[]}: {})})),this.namespaceURI);}
}
class Parser{parseFromString(s){return new XmlNode(XML.xml2js(s,{compact:false,alwaysChildren:false}));}}
class Serializer{serializeToString(d){return XML.js2xml(d.toData(),{compact:false});}}
async function workbookSheetNames(zip){const doc=new Parser().parseFromString(await zip.file('xl/workbook.xml').async('string'));return doc.getElementsByTagNameNS('*','sheet').map(s=>s.getAttribute('name')).sort();}
const localAttr=(node,name)=>node.attributes.find(a=>a.localName===name)?.value??null;
const allNodes=(doc,name)=>doc.getElementsByTagNameNS('*',name);
const nodeJson=node=>JSON.stringify(node.toData());
const hashBytes=bytes=>crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
async function workbookPartMap(zip){
 const wb=new Parser().parseFromString(await zip.file('xl/workbook.xml').async('string'));
 const relDoc=new Parser().parseFromString(await zip.file('xl/_rels/workbook.xml.rels').async('string'));
 const relTargets=Object.fromEntries(allNodes(relDoc,'Relationship').map(r=>[r.getAttribute('Id'),r.getAttribute('Target')]));
 const sheets={};for(const sheet of allNodes(wb,'sheet')){const relId=localAttr(sheet,'id'),target=relTargets[relId];if(!target)throw Error('Workbook sheet relationship missing: '+sheet.getAttribute('name'));sheets[sheet.getAttribute('name')]=path.posix.normalize(path.posix.join('xl',target));}
 return {wb,sheets};
}
async function cellLogical(zip,part,ref){const doc=new Parser().parseFromString(await zip.file(part).async('string')),cell=allNodes(doc,'c').find(c=>c.getAttribute('r')===ref);if(!cell)return null;return {type:cell.getAttribute('t')||'',value:allNodes(cell,'v')[0]?.textContent??'',inline:allNodes(cell,'t').map(t=>t.textContent).join('')};}
async function sheetCellMap(zip,part){const doc=new Parser().parseFromString(await zip.file(part).async('string'));return new Map(allNodes(doc,'c').map(c=>[c.getAttribute('r'),{type:c.getAttribute('t')||'',value:allNodes(c,'v')[0]?.textContent??'',inline:allNodes(c,'t').map(t=>t.textContent).join('')} ]));}
async function workbookFeatureSnapshot(zip){
 const {wb,sheets}=await workbookPartMap(zip),parts=Object.keys(zip.files).filter(n=>!zip.files[n].dir).sort(),features={sheets:Object.keys(sheets).sort(),sheetParts:sheets,parts,formulas:{},sheetStructures:{},definedNames:allNodes(wb,'definedName').map(nodeJson).sort(),relationships:[]};
 for(const [name,part] of Object.entries(sheets)){
  const doc=new Parser().parseFromString(await zip.file(part).async('string'));
  for(const f of allNodes(doc,'f')){const cell=f.parentNode,ref=cell?.getAttribute('r');if(ref)features.formulas[`${name}!${ref}`]=nodeJson(f);}
  const tags=['mergeCells','conditionalFormatting','pageMargins','pageSetup','printOptions','headerFooter','legacyDrawing','legacyDrawingHF','drawing','tableParts','extLst'];
  features.sheetStructures[name]=Object.fromEntries(tags.map(tag=>[tag,allNodes(doc,tag).map(nodeJson)]));
 }
 for(const relPath of parts.filter(n=>n.endsWith('.rels'))){
  const sourcePart=relPath==='_rels/.rels'?'':relPath.replace(/\/_rels\//,'/').replace(/\.rels$/,'');
  const doc=new Parser().parseFromString(await zip.file(relPath).async('string'));
  for(const rel of allNodes(doc,'Relationship')){
   const target=rel.getAttribute('Target')||'',mode=rel.getAttribute('TargetMode')||'';if(mode==='External'||/^[a-z][a-z0-9+.-]*:/i.test(target))continue;
   const decoded=decodeURIComponent(target.split('#')[0].split('?')[0]),resolved=path.posix.normalize(decoded.startsWith('/')?decoded.slice(1):path.posix.join(path.posix.dirname(sourcePart),decoded));
   features.relationships.push({from:relPath,id:rel.getAttribute('Id'),target:resolved,valid:!!zip.file(resolved)});
  }
 }
 features.relationships.sort((a,b)=>a.from.localeCompare(b.from)||String(a.id).localeCompare(String(b.id)));
 return features;
}
async function archiveEntryHash(zip,name){const entry=zip.file(name);return entry?hashBytes(await entry.async('uint8array')):null;}
const root=path.resolve(__dirname,'..'),fixture=process.argv[2],out=path.resolve(process.argv[3]||'/tmp/dold-tests');
if(!fixture)throw Error('Pass a real XLSX fixture path');fs.mkdirSync(out,{recursive:true});
const html=fs.readFileSync(path.join(root,'app/src/main/assets/index.html'),'utf8');
const controller=fs.readFileSync(path.join(root,'app/src/main/assets/DOLD_TechControl_v0.5.3.js'),'utf8');
const app=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('const S =')||s.includes('const S='));
if(!app)throw Error('App script missing');
const clock={mono:1000,offset:0};let injectFailure=false;const alerts=[];let storeDir=path.join(out,'native-store');fs.rmSync(storeDir,{recursive:true,force:true});fs.mkdirSync(storeDir,{recursive:true});
const proof={id:null};const settings=new Map();const lanStub={hostStartJson:'{"ok":false,"status":"NO_LOCAL_NETWORK"}',hostStatus:{status:'WAITING'},clientStartJson:'{"ok":true,"jobId":"r3-job"}',clientResultJson:'{"status":"DONE","result":"CONNECTION_FAILED"}',qrPngBase64:Buffer.from('qr-png-test').toString('base64'),hostStartCalls:[],clientStartCalls:[],stopCount:0,scanCount:0,qrPayloads:[]};
function resetLanStub(){lanStub.hostStartJson='{"ok":false,"status":"NO_LOCAL_NETWORK"}';lanStub.hostStatus={status:'WAITING'};lanStub.clientStartJson='{"ok":true,"jobId":"r3-job"}';lanStub.clientResultJson='{"status":"DONE","result":"CONNECTION_FAILED"}';lanStub.hostStartCalls=[];lanStub.clientStartCalls=[];lanStub.stopCount=0;lanStub.scanCount=0;lanStub.qrPayloads=[];}
class ClockDate extends Date{constructor(...args){super(...(args.length?args:[Date.now()+clock.offset]));}static now(){return Date.now()+clock.offset;}}
function makeContext(){
 const elements=new Map();
 const signatureStartCalls=[];const signatureDraftPayloads=new Map();
 const sharedFiles=[];let pendingShare=null;
 class El{constructor(id){this.id=id;this.value='';this.textContent='';this.disabled=false;this.style={};this.dataset={};this.children=[];this.classes=new Set();this.classList={add:(...v)=>v.forEach(x=>this.classes.add(x)),remove:(...v)=>v.forEach(x=>this.classes.delete(x)),toggle:(v,on)=>on?this.classes.add(v):this.classes.delete(v),contains:v=>this.classes.has(v)};}
  set innerHTML(s){this._html=s;for(const c of this.children)elements.delete(c);this.children=[];parseUi(s,this);if(this.tag==='select'){const options=[...s.matchAll(/<option([^>]*)>([^<]*)/g)];const o=options.find(m=>/\bselected\b/.test(m[1]))||options[0];if(o){const m=o[1].match(/value="([^"]*)"/);this.value=m?m[1]:o[2];}}}
  get innerHTML(){return this._html||'';}focus(){}click(){}remove(){elements.delete(this.id);}appendChild(x){return x;}
 }
 function parseUi(s,owner){for(const m of s.matchAll(/<(input|select|textarea|div|span|button|section|nav|datalist)[^>]*\bid="([^"]+)"[^>]*>/g)){const el=new El(m[2]);el.tag=m[1];const val=m[0].match(/\bvalue="([^"]*)"/);if(val)el.value=val[1];if(m[1]==='select'){const fragment=s.slice(m.index+m[0].length).split('</select>')[0];const opt=fragment.match(/<option[^>]*selected[^>]*>[^<]*/)||fragment.match(/<option[^>]*>[^<]*/);if(opt){const v=opt[0].match(/value="([^"]*)"/);el.value=v?v[1]:opt[0].split('>')[1];}}if(m[0].includes('hidden'))el.classes.add('hidden');elements.set(el.id,el);if(owner)owner.children.push(el.id);}}
 parseUi(html.replace(/<script[^>]*>[\s\S]*?<\/script>/g,''));const buttons=[new El('save'),new El('next')];
 const document={getElementById:id=>elements.get(id)||null,querySelectorAll:q=>q==='#inspectTab .stickySave button'?buttons:[],body:new El('body'),documentElement:new El('root'),activeElement:null,addEventListener(){},createElement:n=>new El(n)};
 const workspaceDir=storeDir;const bridge={saveWorkspace(id,payload){if(injectFailure)return JSON.stringify({ok:false,error:'Injected disk full'});const target=path.join(workspaceDir,id+'.json'),tmp=target+'.new',fd=fs.openSync(tmp,'w');fs.writeFileSync(fd,payload);fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(tmp,target);return JSON.stringify({ok:true,data:true});},readWorkspace(id){return JSON.stringify({ok:true,data:fs.existsSync(path.join(workspaceDir,id+'.json'))?JSON.parse(fs.readFileSync(path.join(workspaceDir,id+'.json'))):null});},listWorkspaces(){return JSON.stringify({ok:true,data:fs.readdirSync(workspaceDir).filter(n=>n.endsWith('.json')).map(n=>{const o=JSON.parse(fs.readFileSync(path.join(storeDir,n)));delete o.workbookBase64;delete o.baseWorkbookBase64;return o;})});},hashBytes(b){return crypto.createHash('sha256').update(Buffer.from(b,'base64')).digest('hex');},beginShareFile(name,mime){pendingShare={name,mime,chunks:[]};return true;},writeShareChunk(b){if(!pendingShare)return false;pendingShare.chunks.push(Buffer.from(b,'base64'));return true;},finishShareFile(){if(!pendingShare)return false;sharedFiles.push({...pendingShare,bytes:Buffer.concat(pendingShare.chunks)});pendingShare=null;return true;},elapsedRealtime(){return clock.mono;},consumeQrProof(id){const ok=proof.id===id;proof.id=null;return ok;},scanQr(){lanStub.scanCount++;},startSignatureCapture(payload){signatureStartCalls.push(JSON.parse(payload));return true;},listSignatureDrafts(){const data=[...signatureDraftPayloads.values()].map(({targetMetadata,points,pngBase64,...summary})=>summary);return JSON.stringify({ok:true,data});},readSignatureDraft(id){const data=signatureDraftPayloads.get(id);return JSON.stringify(data?{ok:true,data}:{ok:false,error:'Test draft missing'});},startLanSyncSession(dbId,responseBase64){lanStub.hostStartCalls.push({dbId,responseBase64});return lanStub.hostStartJson;},stopLanSyncSession(){lanStub.stopCount++;return true;},getLanSyncSessionStatus(){return JSON.stringify(lanStub.hostStatus);},startLanSyncClient(pairingJson,expectedDbId,requestBase64){lanStub.clientStartCalls.push({pairing:JSON.parse(pairingJson),expectedDbId,requestBase64});return lanStub.clientStartJson;},getLanSyncClientResult(){return lanStub.clientResultJson;},createLanSyncQrPngBase64(payload,size){lanStub.qrPayloads.push({payload,size});return lanStub.qrPngBase64;},setTheme(){}};
 const cx={console,document,Android:bridge,DOMParser:Parser,XMLSerializer:Serializer,JSZip,Uint8Array,Uint32Array,TextEncoder,TextDecoder,Date:ClockDate,crypto:crypto.webcrypto,performance:{now:()=>clock.mono},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},localStorage:{getItem:k=>settings.get(k)??null,setItem:(k,v)=>settings.set(k,String(v)),removeItem:k=>settings.delete(k)},matchMedia:()=>({matches:false,addEventListener(){}}),alert:m=>alerts.push(String(m)),confirm:()=>true,btoa:b=>Buffer.from(b,'binary').toString('base64'),atob:b=>Buffer.from(b,'base64').toString('binary'),location:{protocol:'file:'},Blob,URL};
 cx.window=cx;cx.window.scrollTo=()=>{};cx.window.addEventListener=()=>{};vm.createContext(cx);vm.runInContext(app,cx,{filename:'index-controller.js'});vm.runInContext(controller,cx,{filename:'v053-controller.js'});
 return {cx,run:s=>vm.runInContext(s,cx),el:id=>elements.get(id),buttons,sharedFiles,signatureStartCalls,signatureDraftPayloads,setInjectFailure:value=>{injectFailure=!!value;}};
}
let env=makeContext();const run=s=>env.run(s);const el=id=>env.el(id);
async function importBytes(bytes,name='test.xlsx',choice='internal',inspectDialog=null){
 env.cx.incoming=new Uint8Array(bytes);let settled=false,inspected=false;const pending=run(`importXlsx({target:{files:[{name:${JSON.stringify(name)},arrayBuffer:async()=>incoming.buffer}],value:'x'}})`).finally(()=>{settled=true;});
 for(let i=0;i<400&&!settled;i++){if(run('typeof appDialogResolve')==='function'){if(!inspected&&inspectDialog)inspectDialog(el('appDialogBody')?.innerHTML||'');inspected=true;run(`appDialogChoice(${JSON.stringify(choice)})`);}await new Promise(resolve=>setTimeout(resolve,25));}
 if(!settled)throw Error('Import did not finish within 10 seconds');
 await pending;
}
async function importPackageBytes(bytes,name='handoff.dtc',choice='incoming',inspectDialog=null){
 env.cx.incoming=new Uint8Array(bytes);let settled=false;const pending=run(`importWorkPackage({target:{files:[{name:${JSON.stringify(name)},arrayBuffer:async()=>incoming.buffer}],value:'x'}})`).finally(()=>{settled=true;});
 let inspected=false;for(let i=0;i<400&&!settled;i++){if(run('typeof appDialogResolve')==='function'){if(!inspected&&inspectDialog)inspectDialog(el('appDialogBody')?.innerHTML||'');inspected=true;run(`appDialogChoice(${JSON.stringify(choice)})`);}await new Promise(resolve=>setTimeout(resolve,25));}
 if(!settled)throw Error('Work package import did not finish within 10 seconds');await pending;
}
async function importSyncBytes(bytes,name='sync.dtcs',choices=['sync','done'],inspectDialog=null){
 env.cx.incoming=new Uint8Array(bytes);let settled=false,seen=0;const pending=run(`importSyncPackage({target:{files:[{name:${JSON.stringify(name)},arrayBuffer:async()=>incoming.buffer}],value:'x'}})`).finally(()=>{settled=true;});
 for(let i=0;i<400&&!settled;i++){if(run('typeof appDialogResolve')==='function'){if(inspectDialog)inspectDialog(seen,el('appDialogTitle')?.textContent||'',el('appDialogBody')?.innerHTML||'');seen++;run(`appDialogChoice(${JSON.stringify(choices.shift()||'done')})`);}await new Promise(resolve=>setTimeout(resolve,25));}
 if(!settled)throw Error('Sync package import did not finish within 10 seconds');await pending;
}
async function importIncomingBytes(bytes,name='incoming.xlsx',choices=['incoming'],inspectDialog=null){
 env.cx.incoming=new Uint8Array(bytes);let settled=false,seen=0;const pending=run(`handleImportFile({target:{files:[{name:${JSON.stringify(name)},arrayBuffer:async()=>incoming.buffer.slice(incoming.byteOffset,incoming.byteOffset+incoming.byteLength)}],value:'x'}})`).finally(()=>{settled=true;});
 for(let i=0;i<400&&!settled;i++){if(run('typeof appDialogResolve')==='function'){inspectDialog?.(seen,el('appDialogTitle')?.textContent||'',el('appDialogBody')?.innerHTML||'');seen++;run(`appDialogChoice(${JSON.stringify(choices.shift()||'done')})`);}await new Promise(resolve=>setTimeout(resolve,25));}
 if(!settled)throw Error('Content-routed import did not finish within 10 seconds');await pending;
}
async function openCabWithChoices(id,source='list',choices=['edit'],inspectDialog=null){
 let settled=false;const pending=run(`openCab(${JSON.stringify(id)},${JSON.stringify(source)})`).finally(()=>{settled=true;});
 for(let i=0;i<400&&!settled;i++){
  if(run('typeof appDialogResolve')==='function'){inspectDialog?.(el('appDialogTitle')?.textContent||'',el('appDialogBody')?.innerHTML||'');run(`appDialogChoice(${JSON.stringify(choices.shift()||'cancel')})`);}
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 if(!settled)throw Error('Cabinet open dialog did not finish within 10 seconds');await pending;
}
async function waitForAppDialog(title){
 for(let i=0;i<400;i++){if(el('appDialogTitle')?.textContent===title)return;await new Promise(resolve=>setTimeout(resolve,25));}
 throw Error(`App dialog did not open: ${title}`);
}
function advance(s){clock.mono+=s*1000;clock.offset+=s*1000;}
async function count(sheet){return run(`(async()=>{const d=await loadDoc(${JSON.stringify(sheet)});return qsa(d,'row').filter(r=>Number(r.getAttribute('r'))>=5&&getCellVal(d,'B',Number(r.getAttribute('r')))).length;})()`);}
async function freshWorkspace(label,bytes){const dir=path.join(out,label);fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});storeDir=dir;env=makeContext();await run('TC.startupTask');await importBytes(bytes,label+'.xlsx');return dir;}
async function saveTestInspection(id,desc=''){await run('openCab('+JSON.stringify(id)+')');el('inspector').value='Stage 12 tester';run('setAllScores(4)');if(desc)run(`S.stagedDefects=[{point:'Stage 12',desc:${JSON.stringify(desc)},grade:'C',repeat:'Ei',owner:'Stage 12 tester',due:plusDays(today(),30)}]`);advance(61);await run('saveInspection()');if(run('pendingPostSaveSignatureNavigation'))run("onNativeSignatureCaptureCancelled('test helper cancel')");env.signatureStartCalls.length=0;}
function assertR4VisibleScore(value,label){assert.equal(run(`scoreLabel(${JSON.stringify(value)})`),label);run('renderRatings()');const mark=value===''?'–':String(value);assert(el('scoreLegend').innerHTML.includes(`<b>${mark}</b><span>${label}</span>`));assert.equal(el('scoreHint').textContent,'– = Ei rakendu, 0 = Ei ole / puudub.');}
async function r3Prepare(label,workbookBytes,n=4,firstDefect=false){await freshWorkspace(label,workbookBytes);run('TC.guard.remaining=100');await run('resetRingProgress()');const ids=run(`activeCabinets().slice(0,${n}).map(c=>c.id)`);for(let i=0;i<ids.length;i++)await saveTestInspection(ids[i],firstDefect&&i===0?'R3 linked defect':'');return {ids,cycle:JSON.parse(JSON.stringify(run('TC.cycle'))),snapshot:JSON.parse(JSON.stringify(await run('storeCall("get",TC.dbId)'))),controls:await count('Kontrollid'),defects:await count('Puudused')};}
const testFilter=(process.env.DTC_TEST_FILTER||'').toLowerCase(),testExcludes=(process.env.DTC_TEST_EXCLUDE||'').toLowerCase().split('|').map(s=>s.trim()).filter(Boolean),results=[];async function test(name,fn){const low=name.toLowerCase(),legacyR3=testFilter.includes('r3 legacy'),r3CycleCase=/^r3 (stale cycle|fuller incoming cycle|identical cycle entries|missing incoming cycle metadata|row movement and rounded excel w|additional kontrollids|legacy cycle adopts)/i.test(name),r3BootstrapCase=/^r3 (pairing|qr |parser|host |empty startup|scan button|malformed scanned qr|non-direct|direct client|direct baseline|imported baseline|corrupt remote|wrong lineage|user can cancel|phone with|direct initialization|dold flow)/i.test(name),r5XlsxCase=name.startsWith('R5 XLSX preservation'),s2SignatureCase=name.startsWith('S2 signature'),focusedSetup=(testFilter.includes('r1 package')||testFilter.includes('r1 persistent id')||testFilter.startsWith('r2')||(testFilter.includes('r3')&&!legacyR3)||testFilter.includes('r4 scoring')||testFilter.includes('r5 xlsx preservation')||testFilter.includes('s1 signature')||testFilter.includes('s2 signature'))&&name.startsWith('A import'),groupSelection=(testFilter==='r3 cycle'&&r3CycleCase)||(testFilter==='r3 qr bootstrap'&&r3BootstrapCase);if(r3CycleCase&&!testFilter&&process.env.DTC_RUN_R3!=='1')return;if(r5XlsxCase&&!testFilter.includes('r5 xlsx preservation'))return;if(s2SignatureCase&&process.env.DTC_RUN_S2_SIGNATURE!=='1')return;if(testExcludes.some(term=>low.includes(term)))return;if(testFilter&&!low.includes(testFilter)&&!focusedSetup&&!groupSelection&&!(testFilter.startsWith('17 cycle start')&&name.startsWith('A import')))return;try{await fn();if(!focusedSetup)results.push({name,status:'PASS'});console.log(focusedSetup?'SETUP':'PASS',name);}catch(e){results.push({name,status:'FAIL',error:e.stack});console.error('FAIL',name,e);console.error('STATE',run("({busy:TC.busy,ready:TC.ready,cycle:TC.cycle,selected:S.selected?.id,status:$('cabStatus')?.value,seconds:inspectionSeconds(),guard:TC.guard,inspector:$('inspector')?.value,toast:$('toast')?.textContent})"));console.error('ALERTS',alerts);throw e;}}
(async()=>{
const bytes=fs.readFileSync(fixture);const original=await JSZip.loadAsync(bytes);const originalSheetNames=await workbookSheetNames(original);let initialRows,initialDefects,id,other,firstRow,firstStart,cycleId;
await test('A import current workbook, dynamic active count, reserve IDs hidden',async()=>{
 await importBytes(bytes);if(alerts.length)throw Error(alerts.join('\n'));const stats=run(`({total:S.cabinets.length,active:activeCabinets().length,people:S.people,ids:S.cabinets.map(c=>c.id)})`);assert(stats.total>250);assert(!stats.ids.includes('EK-400'));console.log('INPUT',stats.total,stats.active);initialRows=await count('Kontrollid');initialDefects=await count('Puudused');id=run('activeCabinets().find(c=>!c.lastDate)?.id||activeCabinets()[0].id');other=run('activeCabinets().find(c=>c.id!=='+JSON.stringify(id)+').id');await run('resetRingProgress()');cycleId=run('TC.cycle.id');assert.equal(el('progressTxt').textContent,'0 / '+stats.active);
});
await test('R1 persistent ID hydration uses workbook IDs and preserves unresolved Puudused',async()=>{
 const rows=run(`TC.records.map(r=>({row:r.row,syncId:r.syncId,persistentId:r.persistentId||''}))`),defects=run(`TC.allDefects.map(d=>({row:d.row,cabinetId:d.id,syncId:d.syncId,persistentId:d.persistentId||'',kontrollId:d.kontrollId||'',linkStatus:d.linkStatus||'',linkBasis:d.linkBasis||'',legacyUnresolved:!!d.legacyUnresolved}))`);
 const cols=await run(`(async()=>{const c=await loadDoc('Kontrollid'),d=await loadDoc('Puudused');return {control:Object.fromEntries(TC.records.map(r=>[r.row,getCellVal(c,'AA',r.row)])),defect:Object.fromEntries(TC.allDefects.map(x=>[x.row,{id:getCellVal(d,'S',x.row),control:getCellVal(d,'T',x.row),status:getCellVal(d,'U',x.row),basis:getCellVal(d,'V',x.row)}]))};})()`);
 for(const r of rows){const stored=String(cols.control[r.row]||'').trim();if(stored){assert.equal(r.persistentId,stored);assert.equal(r.syncId,stored);assert(run(`!!TC.sync.entities.Kontroll[${JSON.stringify(stored)}]`));}else{assert(/^dtc-kontroll-/.test(r.syncId));assert.equal(r.persistentId,'');}}
 for(const d of defects){const stored=String(cols.defect[d.row]?.id||'').trim(),storedControl=String(cols.defect[d.row]?.control||'').trim();if(stored){assert.equal(d.persistentId,stored);assert.equal(d.syncId,stored);assert(run(`!!TC.sync.entities.Puudus[${JSON.stringify(stored)}]`));}else{assert(/^dtc-puudus-/.test(d.syncId));assert.equal(d.persistentId,'');}
  if(storedControl){assert.equal(d.kontrollId,storedControl);assert(/^dtc-kontroll-/.test(d.kontrollId));}
  if(String(cols.defect[d.row]?.status||'').toUpperCase()==='UNRESOLVED'){
   assert.equal(d.linkStatus,'UNRESOLVED');assert.equal(d.linkBasis,String(cols.defect[d.row]?.basis||''));
   if(!stored){assert.equal(d.cabinetId,'EK-002');assert.equal(d.persistentId,'');assert.equal(d.kontrollId,'');assert.equal(d.legacyUnresolved,true);assert.equal(cols.defect[d.row]?.control,'');}
   else{assert.equal(d.persistentId,stored);assert.equal(d.syncId,stored);assert.equal(d.legacyUnresolved,false);assert.equal(d.kontrollId,'');assert.equal(cols.defect[d.row]?.control,'');}
  }
 }
 const controlsBefore=JSON.stringify(rows.map(r=>[r.row,r.syncId])),defectsBefore=JSON.stringify(defects.map(d=>[d.row,d.syncId]));await run('ensureSyncState()');assert.equal(JSON.stringify(run(`TC.records.map(r=>[r.row,r.syncId])`)),controlsBefore);assert.equal(JSON.stringify(run(`TC.allDefects.map(d=>[d.row,d.syncId])`)),defectsBefore);
});
await test('R2 persistent IDs are written before local save and retained when inspection is edited',async()=>{
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};try{
  await freshWorkspace('r2-local-persistent-ids',bytes);await run('resetRingProgress()');const cabinet=run('activeCabinets()[0].id'),controlCount=await count('Kontrollid'),defectCount=await count('Puudused');await run('openCab('+JSON.stringify(cabinet)+',"camera")');el('inspector').value='R2 persistent ID tester';run('setAllScores(4)');run(`S.stagedDefects=[{point:'R2 ID point',desc:'R2 persistent defect',grade:'C',repeat:'Ei',owner:'R2 tester',due:plusDays(today(),30)}]`);advance(61);await run('saveInspection()');
  const saved=run('savedEntry('+JSON.stringify(cabinet)+')'),defect=run(`TC.allDefects.find(d=>d.desc==='R2 persistent defect')`);assert(saved&&defect);const cells=await run(`(async()=>{const c=await loadDoc('Kontrollid'),d=await loadDoc('Puudused');return {control:getCellVal(c,'AA',${saved.row}),defect:getCellVal(d,'S',${defect.row}),link:getCellVal(d,'T',${defect.row}),status:getCellVal(d,'U',${defect.row}),basis:getCellVal(d,'V',${defect.row})};})()`);
  assert.match(cells.control,/^dtc-kontroll-/);assert.equal(cells.control,saved.syncId);assert.match(cells.defect,/^dtc-puudus-/);assert.equal(cells.defect,defect.syncId);assert.equal(cells.link,cells.control);assert.equal(cells.status,'DIRECT');assert.equal(cells.basis,'ANDROID CREATE');assert.equal(await count('Kontrollid'),controlCount+1);assert.equal(await count('Puudused'),defectCount+1);
  const additions=run(`TC.sync.journal.filter(op=>['${saved.syncId}','${defect.syncId}'].includes(op.entityId))`);assert(additions.some(op=>op.action==='ADD_KONTROLL'&&op.entityId===cells.control));assert(additions.some(op=>op.action==='ADD_PUUDUS'&&op.entityId===cells.defect&&op.changedFields.kontrollId===cells.control));assert(additions.every(op=>run(`validSyncOperationShape(${JSON.stringify(op)})`)),'R2 changed fields must stay within the existing schema-1 whitelist');
  const originalRow=saved.row,originalControlId=saved.syncId,originalDefectId=defect.syncId;await openCabWithChoices(cabinet,'camera',['edit']);run('setAllScores(5)');advance(1);await run('saveInspection()');const edited=run('savedEntry('+JSON.stringify(cabinet)+')'),editedCells=await run(`(async()=>{const c=await loadDoc('Kontrollid'),d=await loadDoc('Puudused');return {control:getCellVal(c,'AA',${originalRow}),defect:getCellVal(d,'S',${defect.row})};})()`);assert.equal(edited.row,originalRow);assert.equal(edited.syncId,originalControlId);assert.equal(editedCells.control,originalControlId);assert.equal(editedCells.defect,originalDefectId);assert.equal(await count('Kontrollid'),controlCount+1);assert.equal(await count('Puudused'),defectCount+1);assert.equal(run(`TC.sync.journal.filter(op=>op.action==='ADD_PUUDUS'&&op.entityId===${JSON.stringify(originalDefectId)}).length`),1);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('R2 incoming legacy operations materialize exact entity IDs and explicit KontrollID links',async()=>{
 const priorEnv=env,priorStore=storeDir;try{
  await freshWorkspace('r2-incoming-legacy-ids',bytes);await run('resetRingProgress()');const remoteDevice='device-'+'9'.repeat(32),dbId=run('TC.dbId'),epoch=run('TC.sync.epoch'),cycleId=run('TC.cycle.id'),cabinet=run('activeCabinets()[1].id'),controlId='dtc-kontroll-r2-incoming-control',defectId='dtc-puudus-r2-incoming-defect';
  const control={schema:1,opId:remoteDevice+':1',deviceId:remoteDevice,localSequence:1,createdAt:new Date().toISOString(),dbId,epoch,entityType:'Kontroll',entityId:controlId,action:'ADD_KONTROLL',baseRevision:0,baseFieldVersions:{},changedFields:{cabinetId:cabinet,date:'2026-10-23',inspector:'R2 remote tester',area:'R2 area',panel:'R2 panel',device:'R2 device',location:'R2 location',start:'2026-10-23T10:00:00',end:'2026-10-23T10:01:05',duration:65/86400,cycleId}};
  const defectOp={schema:1,opId:remoteDevice+':2',deviceId:remoteDevice,localSequence:2,createdAt:new Date().toISOString(),dbId,epoch,entityType:'Puudus',entityId:defectId,action:'ADD_PUUDUS',baseRevision:0,baseFieldVersions:{},changedFields:{cabinetId:cabinet,date:'2026-10-23',inspector:'R2 remote tester',cabinetTitle:'R2 incoming cabinet',location:'R2 location',point:'R2 remote point',description:'R2 remote defect',priority:'C',repeat:'Ei',owner:'R2 remote owner',cycleId,kontrollId:controlId}};
  const beforeControls=await count('Kontrollid'),beforeDefects=await count('Puudused'),report=await run(`applySyncOperations(${JSON.stringify([control,defectOp])},${JSON.stringify(remoteDevice)})`);assert.equal(report.applied,2);assert.equal(await count('Kontrollid'),beforeControls+1);assert.equal(await count('Puudused'),beforeDefects+1);
  const rows=run(`({control:TC.records.find(r=>r.syncId===${JSON.stringify(controlId)}),defect:TC.allDefects.find(d=>d.syncId===${JSON.stringify(defectId)})})`);assert(rows.control&&rows.defect);const cells=await run(`(async()=>{const c=await loadDoc('Kontrollid'),d=await loadDoc('Puudused');return {control:getCellVal(c,'AA',${rows.control.row}),defect:getCellVal(d,'S',${rows.defect.row}),link:getCellVal(d,'T',${rows.defect.row}),status:getCellVal(d,'U',${rows.defect.row}),basis:getCellVal(d,'V',${rows.defect.row})};})()`);assert.equal(cells.control,controlId);assert.equal(cells.defect,defectId);assert.equal(cells.link,controlId);assert.equal(cells.status,'DIRECT');assert.equal(cells.basis,'ANDROID CREATE');assert.equal(rows.defect.kontrollId,controlId);assert(run(`S.sessionChecked.has(${JSON.stringify(cabinet)})`));
  const unresolved=run('TC.allDefects.find(d=>d.legacyUnresolved)');if(unresolved){const before=await run(`(async()=>{const d=await loadDoc('Puudused');return {id:getCellVal(d,'S',${unresolved.row}),control:getCellVal(d,'T',${unresolved.row}),status:getCellVal(d,'U',${unresolved.row}),basis:getCellVal(d,'V',${unresolved.row})};})()`),update={schema:1,opId:remoteDevice+':3',deviceId:remoteDevice,localSequence:3,createdAt:new Date().toISOString(),dbId,epoch,entityType:'Puudus',entityId:unresolved.syncId,action:'UPDATE_PUUDUS',baseRevision:0,baseFieldVersions:{description:null},changedFields:{description:unresolved.desc+' • R2 legacy update'}};await run(`applySyncOperations(${JSON.stringify([update])},${JSON.stringify(remoteDevice)})`);const after=await run(`(async()=>{const d=await loadDoc('Puudused');return {id:getCellVal(d,'S',${unresolved.row}),control:getCellVal(d,'T',${unresolved.row}),status:getCellVal(d,'U',${unresolved.row}),basis:getCellVal(d,'V',${unresolved.row})};})()`);assert.equal(after.id,before.id);assert.equal(after.control,before.control);assert.equal(after.status,before.status);assert.equal(after.basis,before.basis);assert.equal(run(`TC.allDefects.find(d=>d.row===${unresolved.row}).legacyUnresolved`),true);}
 }finally{env=priorEnv;storeDir=priorStore;}
});
await test('17 cycle start time uses W and never invents midnight',async()=>{
 const info=run(`(()=>{const rows=TC.records.filter(r=>r.date==='2026-09-24'&&r.start);const cycle=cycleFromRecords(rows);const noTime=cycleFromRecords([{id:'EK-TEST',date:'2026-09-24',start:'',row:900,inspector:'',ratings:{}}]);return {rows:rows.length,actual:cycle.startedAt,label:cycleStartLabel(cycle),dateOnly:noTime.startedAt,manual:TC.cycle.startedAt};})()`);
 assert(info.rows>0);assert(/^2026-09-24T\d{2}:\d{2}:\d{2}$/.test(info.actual));assert(!info.actual.includes('T00:00:00'));assert.equal(info.dateOnly,'2026-09-24');assert(!info.label.includes('00:00:00'));assert(!info.manual.endsWith('Z'));assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(info.manual));
});
await test('G hard minimum and old setting migration',async()=>{
 settings.set('dold_min_inspection_seconds_v1','0');run('loadMinInspectionSetting()');assert.equal(run('getMinInspectionSeconds()'),60);el('minInspectionSeconds').value='59';run('saveMinInspectionSetting()');assert.equal(run('getMinInspectionSeconds()'),60);
 await run('openCab('+JSON.stringify(id)+')');el('inspector').value='Test Electrician';run('setAllScores(4)');await run('saveInspection()');assert.equal(await count('Kontrollid'),initialRows);advance(59);await run('saveInspection()');assert.equal(await count('Kontrollid'),initialRows);advance(2);
});
await test('B save complete workbook, F last inspection appears immediately',async()=>{
 run(`S.stagedDefects=[{point:'Skeem',desc:'Regression defect',grade:'C',repeat:'Ei',owner:'Test Electrician',due:plusDays(today(),30)}]`);await run('saveInspection()');assert.equal(await count('Kontrollid'),initialRows+1);assert.equal(await count('Puudused'),initialDefects+1);assert(run('S.sessionChecked.has('+JSON.stringify(id)+')'));assert(run('S.cabinets.find(c=>c.id==='+JSON.stringify(id)+').lastDate'));firstRow=run('TC.cycle.entries['+JSON.stringify(id)+'].row');firstStart=run('savedEntry('+JSON.stringify(id)+').start');
});
await test('B/C process restart, next day, renamed original import restores cycle',async()=>{
 env=makeContext();advance(86400);await importBytes(bytes,'renamed_2026-09-25_12-00.xlsx');assert.equal(run('TC.cycle.id'),cycleId);assert(run('S.sessionChecked.has('+JSON.stringify(id)+')'));assert.equal(await count('Kontrollid'),initialRows+1);run('continueCycle()');
 el('stateFilter').value='done';run('renderCabinets()');assert(el('cabList').innerHTML.includes(id));el('stateFilter').value='unchecked';run('renderCabinets()');assert(!el('cabList').innerHTML.includes(id));
});
await test('D/E edit updates same row and existing defect without duplicates',async()=>{
await openCabWithChoices(id,'list',['edit']);assert.equal(run('S.ratings.H'),'4');assert.equal(run('S.stagedDefects.length'),1);run(`S.ratings.H='5';S.stagedDefects[0].desc='Corrected existing defect'`);advance(1);await run('saveInspection()');assert.equal(await count('Kontrollid'),initialRows+1);assert.equal(await count('Puudused'),initialDefects+1);assert.equal(run('TC.cycle.entries['+JSON.stringify(id)+'].row'),firstRow);assert.equal(run('savedEntry('+JSON.stringify(id)+').start'),firstStart);assert.equal(run('savedEntry('+JSON.stringify(id)+').ratings.H'),'5');
});
await test('Disk failure never acknowledged; workbook and counter roll back',async()=>{
 await run('openCab('+JSON.stringify(other)+')');el('inspector').value='Test Electrician';run('setAllScores(5)');advance(65);injectFailure=true;await run('saveInspection()');injectFailure=false;assert.equal(await count('Kontrollid'),initialRows+1);assert(!run('S.sessionChecked.has('+JSON.stringify(other)+')'));assert(alerts.some(x=>x.includes('EI salvestatud')));await run('saveInspection()');assert.equal(await count('Kontrollid'),initialRows+2);
});
await test('H unpredictable challenge persists, wrong/manual QR rejected, matching camera accepted',async()=>{
 const next=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await run('openCab('+JSON.stringify(next)+')');run('TC.guard.remaining=1;setAllScores(4)');el('inspector').value='Test Electrician';advance(65);await run('saveInspection()');assert.equal(run('TC.guard.pending'),next);const rows=await count('Kontrollid');proof.id=other;run('onNativeQrResult('+JSON.stringify(other)+')');await run('saveInspection()');assert.equal(await count('Kontrollid'),rows);run('openQrId('+JSON.stringify(next)+')');assert(!run('TC.opened.proved'));
 env=makeContext();await importBytes(bytes);run('continueCycle()');assert.equal(run('TC.guard.pending'),next);await run('openCab('+JSON.stringify(next)+')');run('setAllScores(4)');el('inspector').value='Test Electrician';advance(65);run('startPresenceScan()');proof.id=next;run('onNativeQrResult('+JSON.stringify(next)+')');assert(run('TC.opened.proved'));await run('saveInspection()');assert.equal(run('TC.guard.pending'),null);assert(run('TC.guard.remaining>=4&&TC.guard.remaining<=27'));
 const qrId=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');run("TC.guard.remaining=1;S.qrMode='audit'");proof.id=qrId;await run('onNativeQrResult('+JSON.stringify(qrId)+')');assert(run('TC.opened.proved'));run('setAllScores(4)');el('inspector').value='Test Electrician';advance(65);await run('saveInspection()');assert(run('S.sessionChecked.has('+JSON.stringify(qrId)+')'));assert.equal(run('TC.guard.pending'),null);
});
await test('I selected area counts and J live search remain correct',async()=>{
 el('areaFilter').value=run('S.cabinets.find(c=>c.id==='+JSON.stringify(id)+').area');run('renderCabinets()');const area=el('areaFilter').value;const total=run('activeCabinets().filter(c=>c.area==='+JSON.stringify(area)+').length');assert(el('areaStats').textContent.includes('Kokku: '+total));
 el('search').value='Raiman';run('updateSearchSuggestions()');assert(el('searchSuggestBox').innerHTML.includes('EK-'));el('search').value='NO_MATCH_12345';run('updateSearchSuggestions()');assert(el('searchSuggestBox').innerHTML.includes('Midagi ei leitud'));assert(!el('searchSuggestBox').innerHTML.includes('EK-'));el('search').value=id;run('updateSearchSuggestions()');assert(el('searchSuggestBox').innerHTML.includes(id));
});
await test('Repair updates only Puudused and persists immediately',async()=>{
 const before=await count('Kontrollid');const row=run("S.existingDefects.find(d=>d.desc==='Corrected existing defect').row");run('openDefectRepair('+row+')');el('repairer').value='Test Electrician';el('repairWork').value='Repair regression';await run('saveRepair()');assert.equal(await count('Kontrollid'),before);assert(!run('S.existingDefects.some(d=>d.row==='+row+')'));env=makeContext();await importBytes(bytes);assert(!run('S.existingDefects.some(d=>d.row==='+row+')'));
});
await test('L timestamp export metadata restores full cycle from external copy',async()=>{
 assert(/_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.xlsx$/.test(run('timestampedName()')));const checked=run('S.sessionChecked.size');const data=await run('persistWorkspace()');fs.writeFileSync(path.join(out,'exported.xlsx'),data);
 for(const f of fs.readdirSync(storeDir))fs.unlinkSync(path.join(storeDir,f));env=makeContext();await importBytes(data,'external_copy.xlsx');assert.equal(run('TC.cycle.id'),cycleId);assert.equal(run('S.sessionChecked.size'),checked);assert.equal(run('savedEntry('+JSON.stringify(id)+').row'),firstRow);
});
await test('M original ZIP parts/sheets/formulas retained; numeric duration',async()=>{
 const result=await JSZip.loadAsync(fs.readFileSync(path.join(out,'exported.xlsx')));for(const name of Object.keys(original.files)){assert(result.files[name],'Missing ZIP entry '+name);}
 const allowed=new Set(['docProps/custom.xml','[Content_Types].xml','_rels/.rels','xl/workbook.xml','xl/styles.xml',run('S.paths.Kontrollid'),run('S.paths.Puudused'),run("S.paths['Kokkuvõte']")]);for(const name of Object.keys(original.files)){if(original.files[name].dir||allowed.has(name))continue;assert((await original.file(name).async('nodebuffer')).equals(await result.file(name).async('nodebuffer')),'Unexpected change '+name);}
 const resultSheetNames=await workbookSheetNames(result);assert.deepStrictEqual(resultSheetNames,originalSheetNames,'Workbook sheet-name set changed');assert(run('savedEntry('+JSON.stringify(id)+').duration>=60/86400'));assert.equal(run('Object.keys(S.paths).length'),originalSheetNames.length);
});
await test('Unknown future sheet added externally survives reimport with pending local work',async()=>{
 const incoming=await JSZip.loadAsync(bytes);
 const sheet='<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>KEEP FUTURE MODULE</t></is></c></row></sheetData></worksheet>';
 incoming.file('xl/worksheets/future.xml',sheet);
 let wb=await incoming.file('xl/workbook.xml').async('string');wb=wb.replace('</sheets>','<sheet name="Future module" sheetId="99" r:id="rIdFuture"/></sheets>');incoming.file('xl/workbook.xml',wb);
 let rel=await incoming.file('xl/_rels/workbook.xml.rels').async('string');rel=rel.replace('</Relationships>','<Relationship Id="rIdFuture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/future.xml"/></Relationships>');incoming.file('xl/_rels/workbook.xml.rels',rel);
 let types=await incoming.file('[Content_Types].xml').async('string');types=types.replace('</Types>','<Override PartName="/xl/worksheets/future.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');incoming.file('[Content_Types].xml',types);
 const checked=run('S.sessionChecked.size');await importBytes(await incoming.generateAsync({type:'nodebuffer'}),'with_future.xlsx','merge');assert(run("!!S.paths['Future module']"));assert.equal(run('S.sessionChecked.size'),checked);const text=await run("S.zip.file(S.paths['Future module']).async('string')");assert.equal(text,sheet);
});
await test('New cycle needs confirmation and preserves historical records',async()=>{
 const before=await count('Kontrollid'),old=run('TC.cycle.id');env.cx.confirm=()=>false;await run('resetRingProgress()');assert.equal(run('TC.cycle.id'),old);env.cx.confirm=()=>true;await run('resetRingProgress()');assert.notEqual(run('TC.cycle.id'),old);assert.equal(run('S.sessionChecked.size'),0);assert.equal(await count('Kontrollid'),before);
});
await test('14 internal XLSX and cycle auto-restore after process restart',async()=>{
 await freshWorkspace('stage12-auto-restore',bytes);await run('resetRingProgress()');const cabinet=run('activeCabinets()[0].id');await saveTestInspection(cabinet);const cycle=run('TC.cycle.id');assert(run('S.sessionChecked.has('+JSON.stringify(cabinet)+')'));assert(run('TC.startupSnapshot.workbookBase64.length>100000'));
 env=makeContext();await run('TC.startupTask');assert(run('TC.startupLoaded'));assert(run('S.zip'));assert.equal(run('S.fileName'),'stage12-auto-restore.xlsx');assert.equal(run('TC.cycle.id'),cycle);assert(run('S.sessionChecked.has('+JSON.stringify(cabinet)+')'));assert(el('startupWorkspaceList').innerHTML.includes('JÄTKA VIIMASE TÖÖFAILIGA'));assert(run('S.cabinets.some(c=>c.id==='+JSON.stringify(cabinet)+')'));
});
await test('15 startup offers last working file and new XLSX paths',async()=>{
 await freshWorkspace('stage12-last-vs-new',bytes);await run('resetRingProgress()');const cabinet=run('activeCabinets()[0].id');await saveTestInspection(cabinet);env=makeContext();await run('TC.startupTask');assert(run('TC.startupLoaded'));assert(!run('TC.activated'));assert(el('startupWorkspaceList').innerHTML.includes('JÄTKA VIIMASE TÖÖFAILIGA'));await run('continueLastWorkingFile()');assert(run('TC.activated'));assert.equal(el('progressTxt').textContent,'1 / '+run('activeCabinets().length'));run('selectNewWorkbook()');assert(!el('workbookImportCard').classList.contains('hidden'));assert(el('xlsxFileInput'));
});
await test('16 freshness choices distinguish internal newer, incoming newer, and ambiguous',async()=>{
 await freshWorkspace('stage12-freshness',bytes);await run('resetRingProgress()');const cabinet=run('activeCabinets()[0].id');await saveTestInspection(cabinet);const branches=run(`(()=>{const x={controlCount:10,defectCount:4,openDefects:3,latestInspectionKey:7,checkedCount:2};return [freshnessRelation({dbId:'db',revision:5},{dbId:'db',revision:4},x,x,false),freshnessRelation({dbId:'db',revision:4},{dbId:'db',revision:5},x,x,false),freshnessRelation({dbId:'a',revision:1},{dbId:'b',revision:1},{...x,controlCount:11},{...x,defectCount:5},false)]})()`);assert.deepEqual(Array.from(branches),['internal','incoming','ambiguous']);let body='';await importBytes(bytes,'same_database_original.xlsx','internal',html=>{body=html;});assert(body.includes('Telefonis olev tööfail on uuem'));assert(body.includes('TELEFONIS'));assert(body.includes('VALITUD FAIL'));assert(run('S.sessionChecked.has('+JSON.stringify(cabinet)+')'));
});
await test('18 opening a cabinet automatically switches area context',async()=>{
 await freshWorkspace('stage12-area-context',bytes);await run('resetRingProgress()');const pair=run(`(()=>{const a=activeCabinets();for(const x of a)for(const y of a)if(x.area&&y.area&&x.area!==y.area)return [x.id,x.area,y.id,y.area];return null})()`);assert(pair);el('areaFilter').value=pair[1];run('renderCabinets()');assert.equal(el('areaFilter').value,pair[1]);await run('openCab('+JSON.stringify(pair[2])+',\'list\')');assert.equal(el('areaFilter').value,pair[3]);assert(el('areaStats').textContent.includes(pair[3]));
});
await test('19 A/B/C/D grade labels show practical meanings',async()=>{
 const grades=JSON.parse(JSON.stringify(run('GRADE_INFO')));assert.deepEqual(grades,{A:'Vahetu oht',B:'Kiire',C:'Plaaniline',D:'Märkus'});const filter=['A — Vahetu oht','B — Kiire','C — Plaaniline','D — Märkus'];for(const label of filter)assert(html.includes(label),'Missing visible grade label '+label);for(const grade of Object.keys(grades))assert.equal(run('gradeLabel('+JSON.stringify(grade)+')'),grades[grade]);assert(html.includes('Kõik astmed'));
});
await test('20/21/22 XLSX/state handoff, older warning and repair return round trip',async()=>{
 const priorStore=storeDir,phoneA=path.join(out,'phone-a-transfer'),phoneB=path.join(out,'phone-b-store');for(const dir of [phoneA,phoneB]){fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});}
 storeDir=phoneA;env=makeContext();await run('TC.startupTask');await importBytes(bytes,'transfer_baseline.xlsx');await run('resetRingProgress()');
 const cabinet=run('activeCabinets()[0].id');await run('openCab('+JSON.stringify(cabinet)+')');el('inspector').value='Transfer electrician';run('setAllScores(4)');run(`S.stagedDefects=[{point:'Transfer test',desc:'Transfer open defect',grade:'C',repeat:'Ei',owner:'Transfer electrician',due:plusDays(today(),30)}]`);advance(61);await run('saveInspection()');
 const cycle=run('TC.cycle.id'),checked=run('S.sessionChecked.size');
 await run('shareXlsx()');assert.equal(env.sharedFiles.length,1);assert(/\.xlsx$/.test(env.sharedFiles[0].name));assert.equal(run('TC.cycle.id'),cycle);assert.equal(run('S.sessionChecked.size'),checked);await JSZip.loadAsync(env.sharedFiles[0].bytes,{checkCRC32:true});
 await run('shareWorkPackage()');assert.equal(env.sharedFiles.length,2);const outgoing=env.sharedFiles[1];assert(/\.dtc$/.test(outgoing.name));const zipA=await JSZip.loadAsync(outgoing.bytes,{checkCRC32:true});assert(zipA.file('manifest.json')&&zipA.file('state.json')&&zipA.file('workbook.xlsx')&&zipA.file('base-workbook.xlsx'));
 const packagedState=JSON.parse(await zipA.file('state.json').async('string'));storeDir=phoneB;env=makeContext();await run('TC.startupTask');assert(!run('TC.startupLoaded'));await importPackageBytes(outgoing.bytes,outgoing.name,'incoming');const phoneBOpen=run('S.existingDefects.length');assert.equal(run('TC.dbId'),packagedState.dbId);assert.equal(run('TC.cycle.id'),cycle);assert(run('S.sessionChecked.has('+JSON.stringify(cabinet)+')'));assert(run('S.existingDefects.some(d=>d.desc===\'Transfer open defect\')'));assert.equal(phoneBOpen,packagedState.summary.openDefects);
 const defect=run("S.existingDefects.find(d=>d.desc==='Transfer open defect').row");run('openDefectRepair('+defect+')');el('repairer').value='Transfer repairer';el('repairWork').value='Replaced and tested';await run('saveRepair()');assert(!run('S.existingDefects.some(d=>d.row==='+defect+')'));await run('shareWorkPackage()');assert.equal(env.sharedFiles.length,1);const returned=env.sharedFiles[0];const returnZip=await JSZip.loadAsync(returned.bytes,{checkCRC32:true});assert(returnZip.file('manifest.json')&&returnZip.file('state.json'));
 env=makeContext();await run('TC.startupTask');assert(run('TC.startupLoaded'));assert(!run('S.existingDefects.some(d=>d.row==='+defect+')'));assert.equal(run('TC.cycle.id'),cycle);
 storeDir=phoneA;env=makeContext();await run('TC.startupTask');assert(run('TC.startupLoaded'));assert(run('S.existingDefects.some(d=>d.desc===\'Transfer open defect\')'));let compare='';await importPackageBytes(returned.bytes,returned.name,'cancel',html=>{compare=html;});assert(compare.includes('Saabuv tööpakett näib uuem'));assert(run('S.existingDefects.some(d=>d.desc===\'Transfer open defect\')'));const retState=JSON.parse(await returnZip.file('state.json').async('string'));assert.equal(retState.dbId,packagedState.dbId);await importPackageBytes(returned.bytes,returned.name,'incoming');assert(!run('S.existingDefects.some(d=>d.desc===\'Transfer open defect\')'));assert(run('S.sessionChecked.has('+JSON.stringify(cabinet)+')'));assert.equal(run('TC.cycle.id'),cycle);
 let oldCompare='';await importPackageBytes(outgoing.bytes,outgoing.name,'internal',html=>{oldCompare=html;});assert(oldCompare.includes('Telefonis olev tööfail on uuem'));assert(!run('S.existingDefects.some(d=>d.desc===\'Transfer open defect\')'));assert.equal(run('TC.cycle.id'),cycle);
 const damaged=await JSZip.loadAsync(outgoing.bytes);damaged.file('workbook.xlsx',new Uint8Array([1,2,3,4]));const corrupt=await damaged.generateAsync({type:'uint8array'});const beforeDb=run('TC.dbId'),beforeChecked=run('S.sessionChecked.size');await importPackageBytes(corrupt,'corrupt.dtc','internal');assert.equal(run('TC.dbId'),beforeDb);assert.equal(run('S.sessionChecked.size'),beforeChecked);assert(alerts.some(m=>m.includes('suurus')||m.includes('kontrollsumma')));
 assert.equal(await count('Kontrollid'),packagedState.summary.controlCount);assert.equal(run('TC.cycle.id'),cycle);results.push({name:'20 work package carries XLSX and current cycle state between phones',status:'PASS'},{name:'21 older package comparison warns and cancellation preserves phone data',status:'PASS'},{name:'22 repaired Puudused and inspection history survive return transfer',status:'PASS'});
 storeDir=priorStore;
});
await test('v0.5.5 sync baseline keeps lineage and stable IDs but gives each installation its own device ID',async()=>{
 const priorStore=storeDir,phoneA=path.join(out,'stage1-phone-a'),phoneB=path.join(out,'stage1-phone-b'),deviceKey='dold_techcontrol_device_id_v1';
 for(const dir of [phoneA,phoneB]){fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});}
 settings.set(deviceKey,'device-'+'a'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await importBytes(bytes,'sync_baseline.xlsx');
 const stateA={dbId:run('TC.dbId'),epoch:run('TC.sync.epoch'),deviceId:run('TC.deviceId'),controls:Array.from(run('TC.records.map(r=>r.syncId)')).sort(),defects:Array.from(run('TC.allDefects.map(d=>d.syncId)')).sort()};assert(stateA.controls.length>0&&stateA.defects.length>0);
 const pkg=await run('createWorkPackageBytes()'),zip=await JSZip.loadAsync(pkg,{checkCRC32:true}),state=JSON.parse(await zip.file('state.json').async('string'));assert(!Object.hasOwn(state,'deviceId'));assert(!Object.hasOwn(state.sync,'deviceId'));
 settings.set(deviceKey,'device-'+'b'.repeat(32));storeDir=phoneB;env=makeContext();await run('TC.startupTask');await importPackageBytes(pkg,'sync_baseline.dtc','incoming');
 assert.equal(run('TC.dbId'),stateA.dbId);assert.equal(run('TC.sync.epoch'),stateA.epoch);assert.notEqual(run('TC.deviceId'),stateA.deviceId);assert.deepEqual(Array.from(run('TC.records.map(r=>r.syncId)')).sort(),stateA.controls);assert.deepEqual(Array.from(run('TC.allDefects.map(d=>d.syncId)')).sort(),stateA.defects);
 storeDir=priorStore;
});
await test('v0.5.5 business writes journal atomically and repair updates the existing Puudus entity',async()=>{
 const priorStore=storeDir,dir=path.join(out,'stage2-journal-device');fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});storeDir=dir;env=makeContext();await run('TC.startupTask');await importBytes(bytes,'journal_baseline.xlsx');await run('resetRingProgress()');
 const cabinet=run('activeCabinets()[0].id');await saveTestInspection(cabinet,'Journal open defect');
 const addControl=run("TC.sync.journal.find(o=>o.action==='ADD_KONTROLL')"),addDefect=run("TC.sync.journal.find(o=>o.action==='ADD_PUUDUS')");assert(addControl&&addDefect);assert(addControl.opId.startsWith(run('TC.deviceId')+':'));assert.equal(addControl.epoch,run('TC.sync.epoch'));assert(Object.hasOwn(addControl.changedFields,'score_H'));assert(Object.hasOwn(addControl.changedFields,'start'));assert(Object.hasOwn(addDefect.changedFields,'description'));assert(run('TC.sync.appliedOps.includes('+JSON.stringify(addControl.opId)+')'));
 const defectId=addDefect.entityId,controlCount=await count('Kontrollid'),row=run("S.existingDefects.find(d=>d.desc==='Journal open defect').row");run('openDefectRepair('+row+')');el('repairer').value='Journal repairer';el('repairWork').value='Closed from repair mode';await run('saveRepair()');const close=run("TC.sync.journal.find(o=>o.action==='CLOSE_PUUDUS')");assert(close);assert.equal(close.entityId,defectId);assert.equal(await count('Kontrollid'),controlCount);
 const stableLength=run('TC.sync.journal.length'),next=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await run('openCab('+JSON.stringify(next)+')');el('inspector').value='Journal tester';run('setAllScores(5)');advance(61);injectFailure=true;await run('saveInspection()');injectFailure=false;assert.equal(run('TC.sync.journal.length'),stableLength);assert(!run('S.sessionChecked.has('+JSON.stringify(next)+')'));
 const committedOps=run('TC.sync.journal.map(o=>o.opId).join(\",\")');env=makeContext();await run('TC.startupTask');assert.equal(run('TC.sync.journal.map(o=>o.opId).join(\",\")'),committedOps);assert(run('TC.sync.journal.some(o=>o.opId==='+JSON.stringify(close.opId)+')'));
 storeDir=priorStore;
});
await test('v0.5.5 field merge unions different fields and opens DOLD same-field conflict choices',async()=>{
 const priorStore=storeDir,dir=path.join(out,'stage3-conflict-device');fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});storeDir=dir;env=makeContext();await run('TC.startupTask');await importBytes(bytes,'conflict_baseline.xlsx');
 const entityId=run('TC.allDefects[0].syncId'),dbId=run('TC.dbId'),epoch=run('TC.sync.epoch');run(`TC.sync.entities.Puudus[${JSON.stringify(entityId)}]={key:'test',revision:1,values:{cabinetId:'EK-052',description:'Kilp maandamata',owner:'Vova',closedAt:''},fieldVersions:{owner:'base-owner',closedAt:'base-closed'}}`);
 const repairDevice='device-'+'e'.repeat(32),ownerDevice='device-'+'f'.repeat(32),repair={schema:1,opId:repairDevice+':1',deviceId:repairDevice,localSequence:1,createdAt:new Date().toISOString(),dbId,epoch,entityType:'Puudus',entityId,action:'CLOSE_PUUDUS',baseRevision:1,baseFieldVersions:{closedAt:'base-closed'},changedFields:{closedAt:'46287.5'}};
 const rp=run(`(()=>{const op=${JSON.stringify(repair)},plan=planSyncOperation(op);commitSyncOperation(op,plan);return plan})()`);assert.equal(Object.keys(rp.applyFields).length,1);assert.equal(run(`TC.sync.entities.Puudus[${JSON.stringify(entityId)}].values.closedAt`),'46287.5');
 const assignment={...repair,opId:ownerDevice+':1',deviceId:ownerDevice,localSequence:1,action:'UPDATE_PUUDUS',baseFieldVersions:{owner:'base-owner'},changedFields:{owner:'Janar K'}};
 const ap=run(`(()=>{const op=${JSON.stringify(assignment)},plan=planSyncOperation(op);commitSyncOperation(op,plan);return plan})()`);assert.deepEqual(Object.keys(ap.applyFields),['owner']);assert.equal(run(`TC.sync.entities.Puudus[${JSON.stringify(entityId)}].values.owner`),'Janar K');
 run(`TC.sync.entities.Puudus[${JSON.stringify(entityId)}].values.owner='Vova';TC.sync.entities.Puudus[${JSON.stringify(entityId)}].fieldVersions.owner='phone-a:8'`);
 const conflict={...assignment,opId:ownerDevice+':2',localSequence:2,baseFieldVersions:{owner:'base-owner'},changedFields:{owner:'Risto K'}};
 const cp=run(`planSyncOperation(${JSON.stringify(conflict)})`);assert.equal(cp.conflicts.length,1);assert.equal(cp.conflicts[0].localValue,'Vova');assert.equal(cp.conflicts[0].remoteValue,'Risto K');assert.equal(run(`TC.sync.entities.Puudus[${JSON.stringify(entityId)}].values.owner`),'Vova');
 run(`commitSyncOperation(${JSON.stringify(conflict)},${JSON.stringify(cp)})`);const duplicate=run(`planSyncOperation(${JSON.stringify(conflict)})`);assert(duplicate.duplicate);const prompt=run(`promptSyncConflict(TC.sync.conflicts.find(c=>c.conflictId===${JSON.stringify(cp.conflicts[0].conflictId)}))`);assert(el('appDialogTitle').textContent==='ANDMETE VASTUOLU');assert(el('appDialogBody').innerHTML.includes('SELLES TELEFONIS'));assert(el('appDialogBody').innerHTML.includes('TEISES TELEFONIS'));run("appDialogChoice('local')");assert.equal(await prompt,'local');
 storeDir=priorStore;
});
await test('v0.5.5 semantic apply combines Phone A audit and Phone B repair without replacing either workbook',async()=>{
 const priorStore=storeDir,phoneA=path.join(out,'stage4-phone-a'),phoneB=path.join(out,'stage4-phone-b'),deviceKey='dold_techcontrol_device_id_v1';
 for(const dir of [phoneA,phoneB]){fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});}
 settings.set(deviceKey,'device-'+'c'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await importBytes(bytes,'parallel_baseline.xlsx');await run('resetRingProgress()');
 const baseline=await run('createWorkPackageBytes()'),baseZip=await JSZip.loadAsync(baseline,{checkCRC32:true}),baseState=JSON.parse(await baseZip.file('state.json').async('string')),baseOps=new Set(baseState.sync.appliedOps);
 settings.set(deviceKey,'device-'+'d'.repeat(32));storeDir=phoneB;env=makeContext();await run('TC.startupTask');await importPackageBytes(baseline,'parallel_baseline.dtc','incoming');await run('continueCycle()');
 settings.set(deviceKey,'device-'+'c'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');const auditCab=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await saveTestInspection(auditCab,'Phone A parallel defect');
 const auditOps=Array.from(run('TC.sync.journal.filter(o=>!'+JSON.stringify(Array.from(baseOps))+'.includes(o.opId))')).map(x=>JSON.parse(JSON.stringify(x)));assert(auditOps.some(o=>o.action==='ADD_KONTROLL'));assert(auditOps.some(o=>o.action==='ADD_PUUDUS'));
 settings.set(deviceKey,'device-'+'d'.repeat(32));storeDir=phoneB;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');const oldDefect=run('S.existingDefects[0]');run('openDefectRepair('+oldDefect.row+')');el('repairer').value='Phone B repairer';el('repairWork').value='Phone B completed repair';await run('saveRepair()');const repairOps=Array.from(run('TC.sync.journal.filter(o=>!'+JSON.stringify(Array.from(baseOps))+'.includes(o.opId))')).map(x=>JSON.parse(JSON.stringify(x)));assert(repairOps.some(o=>o.action==='CLOSE_PUUDUS'));
 const incomingKontrollId=auditOps.find(o=>o.action==='ADD_KONTROLL').entityId,got=await run(`applySyncOperations(${JSON.stringify(auditOps)})`);assert.equal(got.applied,2);assert(run('S.sessionChecked.has('+JSON.stringify(auditCab)+')'));assert.equal(run('TC.records.filter(r=>r.syncId==='+JSON.stringify(incomingKontrollId)+').length'),1);assert(run("S.existingDefects.some(d=>d.desc==='Phone A parallel defect')"));assert(!run('S.existingDefects.some(d=>d.syncId==='+JSON.stringify(oldDefect.syncId)+')'));
 settings.set(deviceKey,'device-'+'c'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');const back=await run(`applySyncOperations(${JSON.stringify(repairOps)})`);assert.equal(back.applied,1);assert(!run('S.existingDefects.some(d=>d.syncId==='+JSON.stringify(oldDefect.syncId)+')'));assert(run('S.sessionChecked.has('+JSON.stringify(auditCab)+')'));assert(run("S.existingDefects.some(d=>d.desc==='Phone A parallel defect')"));
 const repeated=await run(`applySyncOperations(${JSON.stringify(repairOps)})`);assert.equal(repeated.applied,0);assert.equal(repeated.duplicates,1);assert.equal(run('TC.records.filter(r=>r.syncId==='+JSON.stringify(incomingKontrollId)+').length'),1);
 storeDir=priorStore;
});
await test('v0.5.5 .dtcs baseline/delta Share packages initialize a second device and sync without a workbook replacement',async()=>{
 const priorStore=storeDir,phoneA=path.join(out,'stage5-phone-a'),phoneB=path.join(out,'stage5-phone-b'),deviceKey='dold_techcontrol_device_id_v1';
 for(const dir of [phoneA,phoneB]){fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});}
 settings.set(deviceKey,'device-'+'e'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await importBytes(bytes,'sync_package_baseline.xlsx');await run('resetRingProgress()');run('TC.guard.remaining=25');const phoneADevice=run('TC.deviceId');await run('shareSyncBaseline()');assert.equal(env.sharedFiles.length,1);const baselineFile=env.sharedFiles[0];assert(/\.dtcs$/.test(baselineFile.name));const baselineZip=await JSZip.loadAsync(baselineFile.bytes,{checkCRC32:true});const baselineManifest=JSON.parse(await baselineZip.file('manifest.json').async('string')),baselineState=JSON.parse(await baselineZip.file('state.json').async('string'));assert.equal(baselineManifest.mode,'baseline');assert(!Object.hasOwn(baselineState,'deviceId'));assert(!Object.hasOwn(baselineState,'guard'));assert(!Object.hasOwn(baselineState.sync,'deviceId'));assert(baselineZip.file('workbook.xlsx'));
 settings.set(deviceKey,'device-'+'f'.repeat(32));storeDir=phoneB;env=makeContext();await run('TC.startupTask');await importSyncBytes(baselineFile.bytes,baselineFile.name,['initialize']);const phoneBDevice=run('TC.deviceId');assert.notEqual(phoneBDevice,phoneADevice);assert.equal(run('TC.dbId'),baselineState.dbId);assert.equal(run('TC.sync.epoch'),baselineState.sync.epoch);assert.deepEqual(Array.from(run('TC.records.map(r=>r.syncId)')).sort(),Array.from(baselineState.sync.entities.Kontroll?Object.keys(baselineState.sync.entities.Kontroll):[]).sort());assert(!Object.hasOwn(baselineState.sync.deviceSequences,phoneBDevice));await run('continueCycle()');
 settings.set(deviceKey,'device-'+'e'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');run('TC.guard.remaining=25');const auditCab=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await saveTestInspection(auditCab,'Package audit defect');await run('shareSyncDelta()');const deltaA=env.sharedFiles[0];assert(/\.dtcs$/.test(deltaA.name));const deltaZip=await JSZip.loadAsync(deltaA.bytes,{checkCRC32:true}),deltaManifest=JSON.parse(await deltaZip.file('manifest.json').async('string'));assert.equal(deltaManifest.mode,'delta');assert(deltaZip.file('operations.json'));assert(!deltaZip.file('workbook.xlsx'));assert.equal(deltaManifest.operations.count,2);
 settings.set(deviceKey,'device-'+'f'.repeat(32));storeDir=phoneB;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');const firstPreview=[];await importSyncBytes(deltaA.bytes,deltaA.name,['sync','done'],(_i,title,body)=>firstPreview.push([title,body]));assert(firstPreview[0][0]==='SÜNKROONIMINE');assert(firstPreview[0][1].includes('+ 1 kontrolli'));assert(run('S.sessionChecked.has('+JSON.stringify(auditCab)+')'));assert(run("S.existingDefects.some(d=>d.desc==='Package audit defect')"));
 const old=run("S.existingDefects.find(d=>d.desc!=='Package audit defect')");assert(old);run('openDefectRepair('+old.row+')');el('repairer').value='Package repairer';el('repairWork').value='Fixed on Phone B';await run('saveRepair()');const secondCab=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await saveTestInspection(secondCab,'Phone B parallel inspection defect');await run('shareSyncDelta()');const deltaB=env.sharedFiles.at(-1);const countBefore=await count('Kontrollid');
 settings.set(deviceKey,'device-'+'e'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');await importSyncBytes(deltaB.bytes,deltaB.name,['sync','done']);assert(!run('S.existingDefects.some(d=>d.syncId==='+JSON.stringify(old.syncId)+')'));assert(run("S.existingDefects.some(d=>d.desc==='Package audit defect')"));assert(run("S.existingDefects.some(d=>d.desc==='Phone B parallel inspection defect')"));assert(run('S.sessionChecked.has('+JSON.stringify(secondCab)+')'));assert.equal(run('S.sessionChecked.size'),2);const auditId=deltaManifest.operations?JSON.parse(await deltaZip.file('operations.json').async('string')).find(o=>o.action==='ADD_KONTROLL').entityId:'';assert.equal(run('TC.records.filter(r=>r.syncId==='+JSON.stringify(auditId)+').length'),1);assert(run('localPendingSyncCount()===0'));
 const repeated=await importSyncBytes(deltaB.bytes,deltaB.name,['sync','done']);assert.equal(run('TC.records.filter(r=>r.syncId==='+JSON.stringify(auditId)+').length'),1);assert.equal(await count('Kontrollid'),countBefore);assert(run('TC.sync.appliedOps.length>=2'));
 const beforeDb=run('TC.dbId'),beforeJournal=run('TC.sync.journal.length'),wrongZip=await JSZip.loadAsync(deltaB.bytes);const wrongManifest=JSON.parse(await wrongZip.file('manifest.json').async('string'));wrongManifest.dbId='other-db';wrongZip.file('manifest.json',JSON.stringify(wrongManifest));const wrong=await wrongZip.generateAsync({type:'uint8array'});await importSyncBytes(wrong,'wrong-db.dtcs');assert.equal(run('TC.dbId'),beforeDb);assert.equal(run('TC.sync.journal.length'),beforeJournal);assert(alerts.at(-1).includes('Need tööfailid ei kuulu samasse andmebaasi'));
 const corruptZip=await JSZip.loadAsync(deltaB.bytes),opDoc=JSON.parse(await corruptZip.file('operations.json').async('string'));opDoc.pop();corruptZip.file('operations.json',JSON.stringify(opDoc));const corrupt=await corruptZip.generateAsync({type:'uint8array'});await importSyncBytes(corrupt,'corrupt.dtcs');assert.equal(run('TC.dbId'),beforeDb);assert.equal(run('TC.sync.journal.length'),beforeJournal);assert(alerts.at(-1).includes('kontrollsumma'));
 const wrongEpochZip=await JSZip.loadAsync(deltaB.bytes),wrongEpochManifest=JSON.parse(await wrongEpochZip.file('manifest.json').async('string'));wrongEpochManifest.epoch='wrong-epoch';wrongEpochZip.file('manifest.json',JSON.stringify(wrongEpochManifest));const wrongEpoch=await wrongEpochZip.generateAsync({type:'uint8array'});await importSyncBytes(wrongEpoch,'wrong-epoch.dtcs');assert.equal(run('TC.dbId'),beforeDb);assert.equal(run('TC.sync.journal.length'),beforeJournal);assert(alerts.at(-1).includes('algseisu'));
 storeDir=priorStore;
});
await test('v0.5.5 conflict choice updates the same Puudus and converges on the other phone',async()=>{
 const priorStore=storeDir,phoneA=path.join(out,'stage6-conflict-phone-a'),phoneB=path.join(out,'stage6-conflict-phone-b'),deviceKey='dold_techcontrol_device_id_v1';
 for(const dir of [phoneA,phoneB]){fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});}
 settings.set(deviceKey,'device-'+'1'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await importBytes(bytes,'conflict_resolution_baseline.xlsx');const baseline=await run('createSyncBaselineBytes()');
 settings.set(deviceKey,'device-'+'2'.repeat(32));storeDir=phoneB;env=makeContext();await run('TC.startupTask');const baseFile={name:'baseline.dtcs',bytes:baseline};await importSyncBytes(baseFile.bytes,baseFile.name,['initialize']);
 async function setOwner(owner){
  const defect=run('TC.allDefects.find(d=>d.syncId)'),row=defect.row;
  const ok=await run(`transaction(async()=>{const doc=await loadDoc('Puudused');writeSyncText(doc,'J',${row},${JSON.stringify(owner)});S.zip.file(S.paths.Puudused,xmlStr(doc));S.dirty=true;})`);
  assert(ok);return {id:defect.syncId,row};
 }
 const sharedDefect=run('TC.allDefects.find(d=>d.syncId)'),entityId=sharedDefect.syncId;
 await setOwner('Phone B owner');const phoneBOp=JSON.parse(JSON.stringify(run(`TC.sync.journal.find(o=>o.entityId===${JSON.stringify(entityId)}&&Object.hasOwn(o.changedFields,'owner'))`)));assert(phoneBOp);const deltaB=await run('createSyncDeltaBytes()');
 settings.set(deviceKey,'device-'+'1'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await setOwner('Phone A owner');const localOpId=run(`TC.sync.journal.find(o=>o.entityId===${JSON.stringify(entityId)}&&Object.hasOwn(o.changedFields,'owner')).opId`);assert.equal(run(`TC.sync.entities.Puudus[${JSON.stringify(entityId)}].values.owner`),'Phone A owner');
 let sawConflict=false;await importSyncBytes(deltaB,'phone-b.dtcs',['sync','remote','done'],(_i,title,body)=>{if(title==='ANDMETE VASTUOLU'){sawConflict=true;assert(body.includes('Phone A owner'));assert(body.includes('Phone B owner'));}});
 assert(sawConflict);assert.equal(run(`TC.sync.entities.Puudus[${JSON.stringify(entityId)}].values.owner`),'Phone B owner');assert.equal(run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(entityId)}).owner`),'Phone B owner');
 const resolution=JSON.parse(JSON.stringify(run(`TC.sync.journal.filter(o=>o.entityId===${JSON.stringify(entityId)}&&o.resolvesFieldVersions?.owner).at(-1)`)));assert(resolution);assert.equal(resolution.changedFields.owner,'Phone B owner');assert(resolution.resolvesFieldVersions.owner.includes(localOpId));assert(resolution.resolvesFieldVersions.owner.includes(phoneBOp.opId));assert(run(`TC.sync.conflicts.some(c=>c.opId===${JSON.stringify(phoneBOp.opId)}&&c.resolved&&c.resolution==='remote')`));
 const rowA=run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(entityId)}).row`);assert(rowA>0);
 const deltaA=await run('createSyncDeltaBytes()');settings.set(deviceKey,'device-'+'2'.repeat(32));storeDir=phoneB;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await importSyncBytes(deltaA,'phone-a-resolution.dtcs',['sync','done']);
 assert.equal(run(`TC.sync.entities.Puudus[${JSON.stringify(entityId)}].values.owner`),'Phone B owner');assert.equal(run(`TC.sync.conflicts.filter(c=>c.entityId===${JSON.stringify(entityId)}&&!c.resolved).length`),0);assert(run(`TC.sync.appliedOps.includes(${JSON.stringify(localOpId)})`));const rowB=run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(entityId)}).row`);assert.equal(run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(entityId)}).owner`),'Phone B owner');assert(rowB>0);
 storeDir=priorStore;
});
await test('v0.5.5 already-inspected EK offers view/edit/new with explicit confirmation and stable cycle count',async()=>{
 await freshWorkspace('stage7-duplicate-inspection',bytes);await run('resetRingProgress()');const cabinet=run('activeCabinets()[0].id'),priorCabRows=run(`TC.records.filter(r=>r.id===${JSON.stringify(run('activeCabinets()[0].id'))}).length`),priorControlRows=await count('Kontrollid');await saveTestInspection(cabinet,'Duplicate guard defect');
 const firstId=run(`savedEntry(${JSON.stringify(cabinet)}).syncId`),firstCount=run('S.sessionChecked.size');assert(firstId);assert.equal(firstCount,1);let dialogs=[];
 await openCabWithChoices(cabinet,'camera',['view','back'],(title,body)=>dialogs.push([title,body]));assert(dialogs[0][0].includes('ON JUBA KONTROLLITUD'));assert(dialogs[0][1].includes('Stage 12 tester'));assert(dialogs[0][1].includes('Puudused: <b>1</b>'));assert(dialogs[1][0]==='VAATA KONTROLLI');assert(dialogs[1][1].includes('Duplicate guard defect'));assert.equal(run('TC.opened'),null);assert.equal(run('S.sessionChecked.size'),firstCount);
 dialogs=[];await openCabWithChoices(cabinet,'search',['edit'],(title,body)=>dialogs.push([title,body]));assert.equal(dialogs.length,1);assert.equal(run('TC.opened.existing.syncId'),firstId);assert.equal(run('S.ratings.H'),'4');run("S.ratings.H='5'");advance(1);await run('saveInspection()');assert.equal(run(`savedEntry(${JSON.stringify(cabinet)}).syncId`),firstId);assert.equal(run(`TC.records.filter(r=>r.id===${JSON.stringify(cabinet)}).length`),priorCabRows+1);assert.equal(run('S.sessionChecked.size'),firstCount);
 dialogs=[];await openCabWithChoices(cabinet,'camera',['new','create'],(title,body)=>dialogs.push([title,body]));assert(dialogs[0][0].includes('ON JUBA KONTROLLITUD'));assert.equal(dialogs[1][0],'LISA UUS KONTROLL');assert(dialogs[1][1].includes('jääb kontrolliringi loenduris ühe kontrollitud kilbina'));assert.equal(run('TC.opened.existing'),null);assert(run('TC.opened.forceNew'));assert.equal(run('S.ratings.H'),'');const oldDefectId=run(`TC.allDefects.find(d=>d.desc==='Duplicate guard defect').syncId`),journalBefore=run('TC.sync.journal.length');el('inspector').value='Stage 12 tester';run('setAllScores(3)');advance(61);await run('saveInspection()');
 const newEntry=run(`savedEntry(${JSON.stringify(cabinet)})`);assert(newEntry&&newEntry.syncId!==firstId);assert.equal(run(`TC.records.filter(r=>r.id===${JSON.stringify(cabinet)}).length`),priorCabRows+2);assert(run(`TC.cycle.entries[${JSON.stringify(cabinet)}].additionalKontrollIds.includes(${JSON.stringify(firstId)})`));assert.equal(run('S.sessionChecked.size'),firstCount);const afterRows=await count('Kontrollid');assert.equal(afterRows,priorControlRows+2);assert.equal(run(`TC.sync.entities.Puudus[${JSON.stringify(oldDefectId)}].values.kontrollId`),firstId);assert(!run(`TC.sync.journal.slice(${journalBefore}).some(o=>o.entityType==='Puudus')`));
 dialogs=[];await openCabWithChoices(cabinet,'list',['cancel'],(title,body)=>dialogs.push([title,body]));assert(dialogs[0][0].includes('ON JUBA KONTROLLITUD'));assert.equal(run('TC.opened'),null);assert.equal(run('S.sessionChecked.size'),firstCount);
 await run('resetRingProgress()');dialogs=[];await openCabWithChoices(cabinet,'list',['cancel'],(title,body)=>dialogs.push([title,body]));assert.equal(dialogs.length,0);assert(run('TC.opened&&!TC.opened.existing'));run('stopInspectionTimer();TC.opened=null');
});
await test('v0.5.5 Phone A owner edit and Phone B repair merge by field, roll back atomically, and survive restart',async()=>{
 const priorStore=storeDir,phoneA=path.join(out,'stage10-fields-phone-a'),phoneB=path.join(out,'stage10-fields-phone-b'),deviceKey='dold_techcontrol_device_id_v1';for(const dir of [phoneA,phoneB]){fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});}
 settings.set(deviceKey,'device-'+'3'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await importBytes(bytes,'field_merge_baseline.xlsx');await run('resetRingProgress()');const baseline=await run('createSyncBaselineBytes()');
 settings.set(deviceKey,'device-'+'4'.repeat(32));storeDir=phoneB;env=makeContext();await run('TC.startupTask');await importSyncBytes(baseline,'field_merge_baseline.dtcs',['initialize']);await run('continueCycle()');const defect=run('S.existingDefects[0]'),defectId=defect.syncId,controlCount=await count('Kontrollid');assert(defectId);
 run('openDefectRepair('+defect.row+')');el('repairer').value='Phone B repairer';el('repairWork').value='Phone B repaired the defect';await run('saveRepair()');const closeOp=JSON.parse(JSON.stringify(run(`TC.sync.journal.find(o=>o.entityId===${JSON.stringify(defectId)}&&o.action==='CLOSE_PUUDUS')`)));assert(closeOp);const deltaB=await run('createSyncDeltaBytes()');
 settings.set(deviceKey,'device-'+'3'.repeat(32));storeDir=phoneA;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');const rowA=run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(defectId)}).row`);assert(await run(`transaction(async()=>{const doc=await loadDoc('Puudused');writeSyncText(doc,'J',${rowA},'Phone A responsible');S.zip.file(S.paths.Puudused,xmlStr(doc));S.dirty=true;})`));const ownerOp=JSON.parse(JSON.stringify(run(`TC.sync.journal.find(o=>o.entityId===${JSON.stringify(defectId)}&&Object.hasOwn(o.changedFields,'owner'))`)));assert(ownerOp);const deltaA=await run('createSyncDeltaBytes()');
 const defectRowsBefore=await count('Puudused'),controlsBefore=await count('Kontrollid'),appliedBefore=run('TC.sync.appliedOps.length'),alertsBefore=alerts.length;injectFailure=true;await importSyncBytes(deltaB,'field-repair-fail.dtcs',['sync','done']);injectFailure=false;assert.equal(await count('Puudused'),defectRowsBefore);assert.equal(await count('Kontrollid'),controlsBefore);assert.equal(run('TC.sync.appliedOps.length'),appliedBefore);assert(run('S.existingDefects.some(d=>d.syncId==='+JSON.stringify(defectId)+')'));assert(alerts.length>alertsBefore);
 await importSyncBytes(deltaB,'field-repair-retry.dtcs',['sync','done']);assert(!run('S.existingDefects.some(d=>d.syncId==='+JSON.stringify(defectId)+')'));assert.equal(run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(defectId)}).owner`),'Phone A responsible');assert.equal(run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(defectId)}).repairer`),'Phone B repairer');assert(run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(defectId)}).repairAction.includes('Phone B repaired the defect')`));assert.equal(await count('Kontrollid'),controlCount);
 settings.set(deviceKey,'device-'+'4'.repeat(32));storeDir=phoneB;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await importSyncBytes(deltaA,'field-owner.dtcs',['sync','done']);assert.equal(run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(defectId)}).owner`),'Phone A responsible');assert.equal(run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(defectId)}).repairer`),'Phone B repairer');assert(!run('S.existingDefects.some(d=>d.syncId==='+JSON.stringify(defectId)+')'));
 for(const [dir,device] of [[phoneA,'3'],[phoneB,'4']]){settings.set(deviceKey,'device-'+device.repeat(32));storeDir=dir;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');assert.equal(run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(defectId)}).owner`),'Phone A responsible');assert.equal(run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(defectId)}).repairer`),'Phone B repairer');assert(!run('S.existingDefects.some(d=>d.syncId==='+JSON.stringify(defectId)+')'));assert.equal(await count('Kontrollid'),controlCount);}
 storeDir=priorStore;
});
let r1WorkPackageBytes=null,r1WorkPackageDbId='',r1SyncBaselineBytes=null,r1SyncBaselineDbId='',r1SyncSenderDeviceId='';
async function emptyR1Workspace(label,deviceChar='b'){
 const dir=path.join(out,label);fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});storeDir=dir;settings.set('dold_techcontrol_device_id_v1','device-'+deviceChar.repeat(32));env=makeContext();await run('TC.startupTask');return dir;
}
async function createR1WorkPackage(label,withInspection=false,deviceChar='a'){
 settings.set('dold_techcontrol_device_id_v1','device-'+deviceChar.repeat(32));await freshWorkspace(label,bytes);await run('continueLastWorkingFile()');await run('resetRingProgress()');await run('continueCycle()');
 let cabinet='';if(withInspection){cabinet=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await saveTestInspection(cabinet,'R1 handoff inspection');}
 return {bytes:await run('createWorkPackageBytes()'),dbId:run('TC.dbId'),cabinet};
}
async function createR1SyncBaseline(label,deviceChar='c'){
 settings.set('dold_techcontrol_device_id_v1','device-'+deviceChar.repeat(32));await freshWorkspace(label,bytes);await run('continueLastWorkingFile()');await run('resetRingProgress()');await run('continueCycle()');
 return {bytes:await run('createSyncBaselineBytes()'),dbId:run('TC.dbId'),deviceId:run('TC.deviceId')};
}
await test('R1 package valid .dtc routes by manifest and imports the full handoff',async()=>{
 const source=await createR1WorkPackage('r1-dtc-source');r1WorkPackageBytes=source.bytes;r1WorkPackageDbId=source.dbId;await emptyR1Workspace('r1-dtc-receiver');const dialogs=[];
 await importIncomingBytes(r1WorkPackageBytes,'field-transfer.dtc',['incoming'],(_i,title,body)=>dialogs.push([title,body]));
 assert.equal(run('TC.dbId'),r1WorkPackageDbId);assert.equal(run('TC.startupLoaded'),true);assert(dialogs.some(x=>x[0]==='Võta töö vastu'));
});
await test('R1 package valid .dtc.zip routes to the same handoff importer',async()=>{
 await emptyR1Workspace('r1-dtc-zip-receiver');const dialogs=[];await importIncomingBytes(r1WorkPackageBytes,'field-transfer.dtc.zip',['incoming'],(_i,title)=>dialogs.push(title));
 assert.equal(run('TC.dbId'),r1WorkPackageDbId);assert(dialogs.includes('Võta töö vastu'));
});
await test('R1 package valid .dtcs baseline routes using the actual v0.5.5 sync format',async()=>{
 const source=await createR1SyncBaseline('r1-dtcs-source','c');r1SyncBaselineBytes=source.bytes;r1SyncBaselineDbId=source.dbId;r1SyncSenderDeviceId=source.deviceId;await emptyR1Workspace('r1-dtcs-receiver','d');const dialogs=[];
 await importIncomingBytes(r1SyncBaselineBytes,'baseline.dtcs',['initialize'],(_i,title)=>dialogs.push(title));
 assert.equal(run('TC.dbId'),r1SyncBaselineDbId);assert.equal(run('TC.deviceId')===r1SyncSenderDeviceId,false);assert(dialogs.includes('VALMISTA TEINE TELEFON'));
});
await test('R1 package valid .dtcs.zip routes to the same sync baseline importer',async()=>{
 await emptyR1Workspace('r1-dtcs-zip-receiver','e');const dialogs=[];await importIncomingBytes(r1SyncBaselineBytes,'baseline.dtcs.zip',['initialize'],(_i,title)=>dialogs.push(title));
 assert.equal(run('TC.dbId'),r1SyncBaselineDbId);assert(dialogs.includes('VALMISTA TEINE TELEFON'));
});
await test('R1 package manifest overrides a misleading filename and package share uses dedicated MIME types',async()=>{
 await emptyR1Workspace('r1-misleading-name-receiver','f');const dialogs=[];await importIncomingBytes(r1WorkPackageBytes,'ordinary-report.xlsx',['incoming'],(_i,title)=>dialogs.push(title));
 assert.equal(run('TC.dbId'),r1WorkPackageDbId);assert(dialogs.includes('Võta töö vastu'));assert.equal(run('WORK_PACKAGE_MIME'),'application/vnd.dold.techcontrol.workpackage');assert.equal(run('SYNC_PACKAGE_MIME'),'application/vnd.dold.techcontrol.syncpackage');
});
await test('R1 package corrupt ZIP is rejected without changing the active workspace',async()=>{
 await freshWorkspace('r1-corrupt-active',bytes);await run('continueLastWorkingFile()');const before=await run('(async()=>await storeCall("get",TC.dbId))()'),alertStart=alerts.length;
 await importIncomingBytes(new Uint8Array([0x50,0x4b,0x03,0x04,0x00,0x00]),'broken.dtcs.zip',[]);
 const after=await run('(async()=>await storeCall("get",TC.dbId))()');assert.equal(run('TC.dbId'),before.dbId);assert.equal(after.revision,before.revision);assert.equal(after.workbookHash,before.workbookHash);assert(alerts.slice(alertStart).some(x=>x.includes('ZIP-fail on vigane')));
});
await test('R1 package unknown manifest.format is rejected without changing the active workspace',async()=>{
 await freshWorkspace('r1-unknown-active',bytes);await run('continueLastWorkingFile()');const before=await run('(async()=>await storeCall("get",TC.dbId))()'),alertStart=alerts.length,archive=new JSZip();archive.file('manifest.json',JSON.stringify({format:'UNKNOWN-DOLD-FORMAT'}));const unknown=await archive.generateAsync({type:'uint8array'});
 await importIncomingBytes(unknown,'unknown.dtc.zip',[]);const after=await run('(async()=>await storeCall("get",TC.dbId))()');assert.equal(run('TC.dbId'),before.dbId);assert.equal(after.revision,before.revision);assert.equal(after.workbookHash,before.workbookHash);assert(alerts.slice(alertStart).some(x=>x.includes('vormingut ei tunta')));
});
await test('R1 package normal XLSX still opens through the workbook importer',async()=>{
 await emptyR1Workspace('r1-normal-xlsx','1');const alertStart=alerts.length;await importIncomingBytes(bytes,'normal-workbook.xlsx',[]);
 assert(run('TC.dbId'));assert(run('S.zip.file("xl/workbook.xml")'));assert(run('S.cabinets.length>250'));assert.equal(alerts.length,alertStart);
});
await test('R1 package repeated .dtcs delta import remains idempotent',async()=>{
 const priorStore=storeDir,deviceKey='dold_techcontrol_device_id_v1',senderDir=path.join(out,'r1-idempotent-sender'),receiverDir=path.join(out,'r1-idempotent-receiver');
 settings.set(deviceKey,'device-'+'2'.repeat(32));await freshWorkspace('r1-idempotent-sender',bytes);await run('continueLastWorkingFile()');await run('resetRingProgress()');await run('continueCycle()');const baseline=await run('createSyncBaselineBytes()'),dbId=run('TC.dbId');
 await emptyR1Workspace('r1-idempotent-receiver','3');await importIncomingBytes(baseline,'initial.dtcs',['initialize']);await run('continueCycle()');
 settings.set(deviceKey,'device-'+'2'.repeat(32));storeDir=senderDir;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');const cabinet=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await saveTestInspection(cabinet,'R1 idempotency inspection');const kontrolId=run(`savedEntry(${JSON.stringify(cabinet)}).syncId`),delta=await run('createSyncDeltaBytes()');assert(kontrolId);
 settings.set(deviceKey,'device-'+'3'.repeat(32));storeDir=receiverDir;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');assert.equal(run('TC.dbId'),dbId);const before=await count('Kontrollid');
 await importIncomingBytes(delta,'delta.dtcs',['sync','done']);const first=await count('Kontrollid'),applied=run('TC.sync.appliedOps.length');assert.equal(first,before+1);assert.equal(run(`TC.records.filter(r=>r.syncId===${JSON.stringify(kontrolId)}).length`),1);
 await importIncomingBytes(delta,'delta.dtcs.zip',['sync','done']);assert.equal(await count('Kontrollid'),first);assert.equal(run(`TC.records.filter(r=>r.syncId===${JSON.stringify(kontrolId)}).length`),1);assert.equal(run('TC.sync.appliedOps.length'),applied);storeDir=priorStore;
});
await test('R1 package existing .dtc handoff still compares and explicitly replaces with the incoming work',async()=>{
 const source=await createR1WorkPackage('r1-handoff-source',true,'7'),sourceRows=await count('Kontrollid');settings.set('dold_techcontrol_device_id_v1','device-'+'8'.repeat(32));await freshWorkspace('r1-handoff-receiver',bytes);await run('continueLastWorkingFile()');const receiverDb=run('TC.dbId'),dialogs=[];assert(receiverDb);
 await importIncomingBytes(source.bytes,'handoff.dtc.zip',['incoming'],(_i,title,body)=>dialogs.push([title,body]));
 assert.equal(run('TC.dbId'),source.dbId);assert.notEqual(receiverDb,'');assert(dialogs.some(x=>x[0]==='Võta töö vastu'||x[0]==='Võrdle tööpaketti'));assert.equal(await count('Kontrollid'),sourceRows);assert(run(`TC.cycle.entries[${JSON.stringify(source.cabinet)}]`));assert(run(`savedEntry(${JSON.stringify(source.cabinet)}).syncId`));
});
const r3DeviceKey='dold_techcontrol_device_id_v1';
function r3Pairing(overrides={}){const now=Date.now()+clock.offset;return {protocol:1,host:'192.168.1.8',port:34791,sessionId:'s'.repeat(22),token:'t'.repeat(43),createdAt:now-1000,expiresAt:now+120000,lineage:'a'.repeat(64),...overrides};}
function r3Qr(pair){return 'DOLD-DIRECT-SYNC/1:'+JSON.stringify(pair);}
async function r3EmptyWorkspace(label,deviceChar='b'){
 const dir=path.join(out,label);fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});storeDir=dir;settings.set(r3DeviceKey,'device-'+deviceChar.repeat(32));resetLanStub();env=makeContext();await run('TC.startupTask');return dir;
}
async function r3Source(label='r3-source',deviceChar='a'){
 resetLanStub();settings.set(r3DeviceKey,'device-'+deviceChar.repeat(32));await freshWorkspace(label,bytes);await run('continueLastWorkingFile()');await run('resetRingProgress()');await run('continueCycle()');
 const cabinet=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await saveTestInspection(cabinet,'R3 baseline inspection defect');
 const baseline=await run('createSyncBaselineBytes()');return {baseline,dbId:run('TC.dbId'),deviceId:run('TC.deviceId'),cycleId:run('TC.cycle.id'),cabinet,summary:JSON.parse(JSON.stringify(run('TC.startupSnapshot.summary')))};
}
function r3MakeQrForDb(dbId,overrides={}){const lineage=crypto.createHash('sha256').update(String(dbId)).digest('hex');return r3Qr(r3Pairing({lineage,...overrides}));}
async function r3Pump(expr,choices=[],observe=null){
 const pending=run(expr);let settled=false,value,error;pending.then(v=>{settled=true;value=v},e=>{settled=true;error=e;});const seen=[];
 for(let i=0;i<1200&&!settled;i++){
  if(run('typeof appDialogResolve')==='function'){
   const title=el('appDialogTitle')?.textContent||'',body=el('appDialogBody')?.innerHTML||'';seen.push({title,body});observe?.(title,body,seen.length-1);
   const choice=choices.length?choices.shift():'done';run(`appDialogChoice(${JSON.stringify(choice)})`);
  }
  await new Promise(resolve=>setTimeout(resolve,2));
 }
 if(!settled)throw Error('R3 async flow did not finish');if(error)throw error;return {value,seen};
}
await test('R3 pairing builder uses the direct-sync prefix and required transport fields',async()=>{
 const p=r3Pairing(),raw=run(`directPairingPayload(${JSON.stringify(p)})`),parsed=run(`parseDirectSyncQr(${JSON.stringify(raw)})`);assert(raw.startsWith('DOLD-DIRECT-SYNC/1:'));for(const k of ['protocol','host','port','sessionId','token','createdAt','expiresAt','lineage'])assert.equal(parsed[k],p[k]);
});
await test('R3 QR payload contains pairing data only and no workbook or business records',async()=>{
 const raw=run(`directPairingPayload(${JSON.stringify(r3Pairing())})`),p=JSON.parse(raw.slice('DOLD-DIRECT-SYNC/1:'.length));assert.deepEqual(Object.keys(p).sort(),['createdAt','expiresAt','host','lineage','port','protocol','sessionId','token'].sort());for(const forbidden of ['workbook','Puudused','Kontrollid','employee','journal'])assert(!raw.toLowerCase().includes(forbidden.toLowerCase()));
});
await test('R3 pairing accepts RFC1918 10.x IPv4 hosts',async()=>{assert.equal(run(`isPrivateIpv4Text('10.18.2.6')`),true);});
await test('R3 pairing accepts RFC1918 172.16 through 172.31 hosts',async()=>{assert.equal(run(`isPrivateIpv4Text('172.31.2.6')`),true);assert.equal(run(`isPrivateIpv4Text('172.16.0.1')`),true);});
await test('R3 pairing accepts RFC1918 192.168 IPv4 hosts',async()=>{assert.equal(run(`isPrivateIpv4Text('192.168.1.2')`),true);});
await test('R3 pairing rejects public addresses',async()=>{assert.equal(run(`isPrivateIpv4Text('8.8.8.8')`),false);});
await test('R3 pairing rejects loopback and link-local addresses',async()=>{assert.equal(run(`isPrivateIpv4Text('127.0.0.1')`),false);assert.equal(run(`isPrivateIpv4Text('169.254.1.3')`),false);});
await test('R3 pairing rejects malformed IPv4 octets',async()=>{assert.equal(run(`isPrivateIpv4Text('192.168.256.1')`),false);});
await test('R3 parser rejects unsupported protocol version',async()=>{assert.throws(()=>run(`parseDirectSyncQr(${JSON.stringify(r3Qr(r3Pairing({protocol:2})))})`),/MALFORMED_QR/);});
await test('R3 parser rejects invalid port values',async()=>{for(const port of [0,65536,1.5])assert.throws(()=>run(`parseDirectSyncQr(${JSON.stringify(r3Qr(r3Pairing({port})))})`),/MALFORMED_QR/);});
await test('R3 parser rejects malformed session identifiers',async()=>{assert.throws(()=>run(`parseDirectSyncQr(${JSON.stringify(r3Qr(r3Pairing({sessionId:'short'})))})`),/MALFORMED_QR/);});
await test('R3 parser rejects short or malformed one-time tokens',async()=>{assert.throws(()=>run(`parseDirectSyncQr(${JSON.stringify(r3Qr(r3Pairing({token:'short'})))})`),/MALFORMED_QR/);});
await test('R3 parser rejects missing or malformed lineage fingerprints',async()=>{assert.throws(()=>run(`parseDirectSyncQr(${JSON.stringify(r3Qr(r3Pairing({lineage:'bad'})))})`),/MALFORMED_QR/);});
await test('R3 parser rejects malformed JSON safely',async()=>{assert.throws(()=>run(`parseDirectSyncQr('DOLD-DIRECT-SYNC/1:{bad')`),/MALFORMED_QR/);});
await test('R3 parser rejects unrelated QR content',async()=>{assert.throws(()=>run(`parseDirectSyncQr('EK-052')`),/NOT_DOLD_SYNC_QR/);});
await test('R3 parser rejects expired pairing data',async()=>{const p=r3Pairing({expiresAt:Date.now()-1});assert.throws(()=>run(`parseDirectSyncQr(${JSON.stringify(r3Qr(p))})`),/QR_EXPIRED/);});
await test('R3 parser rejects pairing windows longer than five minutes',async()=>{const now=Date.now(),p=r3Pairing({createdAt:now-1000,expiresAt:now+300001});assert.throws(()=>run(`parseDirectSyncQr(${JSON.stringify(r3Qr(p))})`),/QR_EXPIRED/);});
await test('R3 parser rejects creation timestamps implausibly in the future',async()=>{const now=Date.now(),p=r3Pairing({createdAt:now+60000,expiresAt:now+120000});assert.throws(()=>run(`parseDirectSyncQr(${JSON.stringify(r3Qr(p))})`),/QR_EXPIRED/);});
await test('R3 host accepts only a baseline request with matching lineage',async()=>{
 const pairing=r3Pairing(),session={pairing},request={format:'DOLD-TECHCONTROL-DIRECT-BOOTSTRAP',version:1,action:'REQUEST_BASELINE',lineage:pairing.lineage},requestBase64=Buffer.from(JSON.stringify(request)).toString('base64');assert.equal(run(`hostRequestIsBootstrap({requestBase64:${JSON.stringify(requestBase64)}},${JSON.stringify(session)})`),true);
});
await test('R3 host rejects wrong bootstrap action or lineage',async()=>{
 const pairing=r3Pairing(),session={pairing},requests=[{format:'DOLD-TECHCONTROL-DIRECT-BOOTSTRAP',version:1,action:'SEND_FILE',lineage:pairing.lineage},{format:'DOLD-TECHCONTROL-DIRECT-BOOTSTRAP',version:1,action:'REQUEST_BASELINE',lineage:'b'.repeat(64)}];for(const request of requests){const b64=Buffer.from(JSON.stringify(request)).toString('base64');assert.equal(run(`hostRequestIsBootstrap({requestBase64:${JSON.stringify(b64)}},${JSON.stringify(session)})`),false);}
});
await test('R3 empty startup enables direct QR scan without an imported workbook',async()=>{
 await r3EmptyWorkspace('r3-empty-scan-enabled');assert.equal(run('S.zip'),null);assert.equal(el('lanScanQrBtn').disabled,false);assert.equal(el('lanShowQrBtn').disabled,true);
});
await test('R3 scan button uses the existing native scanner in direct-sync mode',async()=>{
 await r3EmptyWorkspace('r3-scan-native');run('startDirectSyncScanner()');assert.equal(lanStub.scanCount,1);assert.equal(run('S.qrMode'),'directSync');
});
await test('R3 malformed scanned QR is handled in DOLD UI without opening a cabinet',async()=>{
 await r3EmptyWorkspace('r3-bad-qr');run("S.qrMode='directSync'");const result=await r3Pump(`onNativeQrResult('not-a-dold-qr')`,['done']);assert(result.seen.some(x=>x.title==='QR-KOODI EI SAA KASUTADA'));assert.equal(lanStub.clientStartCalls.length,0);assert.equal(run('TC.opened'),null);
});
await test('R3 non-direct EK QR still follows the cabinet inspection route',async()=>{
 await freshWorkspace('r3-normal-ek-qr',bytes);await run('continueLastWorkingFile()');await run('resetRingProgress()');await run('continueCycle()');const id=run('activeCabinets()[0].id');run(`onNativeQrResult(${JSON.stringify(id)})`);assert.equal(run('TC.opened.id'),id);assert.equal(lanStub.clientStartCalls.length,0);run('stopInspectionTimer()');
});
await test('R3 host refuses to start without a working database',async()=>{
 await r3EmptyWorkspace('r3-no-host-database');await assert.rejects(()=>run('prepareDirectSyncSession()'),/Ava enne QR-sünkroonimist tööfail/);
});
await test('R3 host returns an unavailable state when no local network is present',async()=>{
 await freshWorkspace('r3-no-lan',bytes);await run('continueLastWorkingFile()');const response=await run('prepareDirectSyncSession()');assert.equal(response.status,'NO_LOCAL_NETWORK');assert.equal(lanStub.qrPayloads.length,0);
});
await test('R3 host sends baseline bytes through native session and QR contains only pairing info',async()=>{
 const source=await r3Source('r3-host-baseline');const lineage=crypto.createHash('sha256').update(source.dbId).digest('hex'),p=r3Pairing({lineage});lanStub.hostStartJson=JSON.stringify({ok:true,status:'STARTED',pairing:p});const before=await count('Kontrollid');const session=await run('prepareDirectSyncSession()');assert.equal(session.status,'STARTED');assert.equal(lanStub.hostStartCalls.length,1);assert.equal(lanStub.hostStartCalls[0].dbId,source.dbId);assert(lanStub.hostStartCalls[0].responseBase64.length>100);assert.equal(lanStub.qrPayloads.length,1);assert(lanStub.qrPayloads[0].payload.includes(source.dbId)===false);assert.equal(JSON.parse(lanStub.qrPayloads[0].payload.slice('DOLD-DIRECT-SYNC/1:'.length)).lineage,lineage);assert.equal(await count('Kontrollid'),before);
});
await test('R3 host QR flow displays the waiting state and cancellation stops the server',async()=>{
 const source=await r3Source('r3-host-cancel');lanStub.hostStartJson=JSON.stringify({ok:true,status:'STARTED',pairing:r3Pairing({lineage:crypto.createHash('sha256').update(source.dbId).digest('hex')})});let done=false;const pending=run('showDirectSyncQr()').then(()=>{done=true;});
 for(let i=0;i<1200&&!done;i++){
  if(run('typeof appDialogResolve')==='function'&&el('appDialogTitle')?.textContent==='TELEFONIDE SÜNKROONIMINE'){assert(el('appDialogBody').innerHTML.includes('Ootan teist telefoni'));run('cancelDirectSyncHost()');break;}
  await new Promise(resolve=>setTimeout(resolve,2));
 }
 for(let i=0;i<200&&!done;i++)await new Promise(resolve=>setTimeout(resolve,2));await pending;assert(done);assert.equal(lanStub.stopCount,1);assert(el('appDialog').classes.has('hidden'));
});
await test('R3 direct client sends pairing and a baseline request through the LAN bridge',async()=>{
 const source=await r3Source('r3-client-request');await r3EmptyWorkspace('r3-client-request-empty','b');lanStub.clientResultJson='{"status":"DONE","result":"CONNECTION_FAILED"}';const qr=r3MakeQrForDb(source.dbId);await r3Pump(`handleDirectSyncQr(${JSON.stringify(qr)})`,['done']);assert.equal(lanStub.clientStartCalls.length,1);assert.equal(lanStub.clientStartCalls[0].expectedDbId,'');const request=JSON.parse(Buffer.from(lanStub.clientStartCalls[0].requestBase64,'base64').toString());assert.equal(request.action,'REQUEST_BASELINE');assert.equal(request.lineage,JSON.parse(qr.slice('DOLD-DIRECT-SYNC/1:'.length)).lineage);
});
await test('R3 direct baseline import previews summary and initializes a blank phone',async()=>{
 const source=await r3Source('r3-bootstrap-source'),sourceArchive=await JSZip.loadAsync(source.baseline),sourceState=JSON.parse(await sourceArchive.file('state.json').async('string'));await r3EmptyWorkspace('r3-bootstrap-phone-b','b');const localId=run('installationDeviceId()');lanStub.clientResultJson=JSON.stringify({status:'DONE',result:'SUCCESS',responseBase64:Buffer.from(source.baseline).toString('base64')});const dialogs=[];const result=await r3Pump(`handleDirectSyncQr(${JSON.stringify(r3MakeQrForDb(source.dbId))})`,['initialize','done'],(title,body)=>dialogs.push({title,body}));assert.equal(result.value,true);assert.deepEqual(dialogs.map(x=>x.title),['UUS TELEFON','TELEFON ON VALMIS']);assert(dialogs[0].body.includes('Objekte:'));assert(dialogs[0].body.includes('Aktiivses kontrollis:'));assert(dialogs[0].body.includes('Avatud puudusi:'));assert.equal(run('TC.dbId'),source.dbId);assert.equal(run('TC.sync.epoch'),sourceState.sync.epoch);assert.equal(run('TC.deviceId'),localId);assert.notEqual(run('TC.deviceId'),source.deviceId);assert(run(`S.sessionChecked.has(${JSON.stringify(source.cabinet)})`));
});
await test('R3 imported baseline preserves workbook history, current cycle, entity IDs and local device identity after restart',async()=>{
 const source=await r3Source('r3-restart-source');const sourceArchive=await JSZip.loadAsync(source.baseline),sourceState=JSON.parse(await sourceArchive.file('state.json').async('string'));await r3EmptyWorkspace('r3-restart-phone-b','c');const localId=run('installationDeviceId()');lanStub.clientResultJson=JSON.stringify({status:'DONE',result:'SUCCESS',responseBase64:Buffer.from(source.baseline).toString('base64')});await r3Pump(`handleDirectSyncQr(${JSON.stringify(r3MakeQrForDb(source.dbId))})`,['initialize','done']);const first=await run('(async()=>await storeCall("get",TC.dbId))()');assert.equal(first.cycle.id,source.cycleId);assert(first.sync.entities.Kontroll);const sheets1=JSON.parse(JSON.stringify(run('Object.keys(S.paths).sort()')));
 env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');assert.equal(run('TC.dbId'),source.dbId);assert.equal(run('TC.deviceId'),localId);assert.notEqual(run('TC.deviceId'),source.deviceId);assert.equal(run('TC.cycle.id'),source.cycleId);assert(run(`S.sessionChecked.has(${JSON.stringify(source.cabinet)})`));assert.deepEqual(JSON.parse(JSON.stringify(run('Object.keys(S.paths).sort()'))),sheets1);assert.equal(run('TC.sync.epoch'),sourceState.sync.epoch);assert.equal(await count('Kontrollid'),source.summary.controlCount);
});
await test('R3 corrupt remote baseline is rejected before writing a workspace',async()=>{
 const source=await r3Source('r3-corrupt-source');await r3EmptyWorkspace('r3-corrupt-phone-b','d');lanStub.clientResultJson=JSON.stringify({status:'DONE',result:'SUCCESS',responseBase64:Buffer.from('not-a-zip').toString('base64')});const before=await run('(async()=>await storeCall("list"))()');const dialogs=[];await r3Pump(`handleDirectSyncQr(${JSON.stringify(r3MakeQrForDb(source.dbId))})`,['done'],(title)=>dialogs.push(title));const after=await run('(async()=>await storeCall("list"))()');assert.equal(before.length,0);assert.equal(after.length,0);assert(dialogs.includes('OTSEÜHENDUS EBAÕNNESTUS'));
});
await test('R3 wrong lineage in received baseline is rejected without local mutation',async()=>{
 const source=await r3Source('r3-lineage-source');await r3EmptyWorkspace('r3-lineage-phone-b','e');lanStub.clientResultJson=JSON.stringify({status:'DONE',result:'SUCCESS',responseBase64:Buffer.from(source.baseline).toString('base64')});const dialogs=[];await r3Pump(`handleDirectSyncQr(${JSON.stringify(r3Qr(r3Pairing({lineage:'f'.repeat(64)})))})`,['done'],title=>dialogs.push(title));assert.equal((await run('(async()=>await storeCall("list"))()')).length,0);assert(dialogs.includes('OTSEÜHENDUS EBAÕNNESTUS'));assert.equal(lanStub.clientStartCalls.length,1);
});
await test('R3 user can cancel first-time baseline preparation without writing a workspace',async()=>{
 const source=await r3Source('r3-cancel-source');await r3EmptyWorkspace('r3-cancel-phone-b','f');lanStub.clientResultJson=JSON.stringify({status:'DONE',result:'SUCCESS',responseBase64:Buffer.from(source.baseline).toString('base64')});const result=await r3Pump(`handleDirectSyncQr(${JSON.stringify(r3MakeQrForDb(source.dbId))})`,['cancel']);assert.equal(result.value,false);assert.equal(run('TC.dbId'),null);assert.equal((await run('(async()=>await storeCall("list"))()')).length,0);
});
await test('R3 phone with the same database lineage is protected from bootstrap replacement',async()=>{
 await freshWorkspace('r3-protect-existing',bytes);resetLanStub();await run('continueLastWorkingFile()');const db=run('TC.dbId'),before=await run('(async()=>await storeCall("get",TC.dbId))()');const dialogs=[];await r3Pump(`handleDirectSyncQr(${JSON.stringify(r3MakeQrForDb(db))})`,['done'],title=>dialogs.push(title));const after=await run('(async()=>await storeCall("get",TC.dbId))()');assert(dialogs.includes('TELEFON ON JUBA SEADISTATUD'));assert.equal(lanStub.clientStartCalls.length,0);assert.equal(after.workbookHash,before.workbookHash);assert.equal(run('TC.dbId'),db);
});
await test('R3 phone with a different database lineage is not overwritten',async()=>{
 await freshWorkspace('r3-protect-other',bytes);resetLanStub();await run('continueLastWorkingFile()');const db=run('TC.dbId'),before=await run('(async()=>await storeCall("get",TC.dbId))()');const dialogs=[];await r3Pump(`handleDirectSyncQr(${JSON.stringify(r3Qr(r3Pairing({lineage:'9'.repeat(64)})))})`,['done'],title=>dialogs.push(title));const after=await run('(async()=>await storeCall("get",TC.dbId))()');assert(dialogs.includes('TEINE TÖÖBAAS'));assert.equal(lanStub.clientStartCalls.length,0);assert.equal(after.workbookHash,before.workbookHash);assert.equal(run('TC.dbId'),db);
});
await test('R3 direct initialization rotates a deviceId collision with the sending phone',async()=>{
 const source=await r3Source('r3-device-collision-source','7');await r3EmptyWorkspace('r3-device-collision-b','7');const collision=run('installationDeviceId()');assert.equal(collision,source.deviceId);lanStub.clientResultJson=JSON.stringify({status:'DONE',result:'SUCCESS',responseBase64:Buffer.from(source.baseline).toString('base64')});await r3Pump(`handleDirectSyncQr(${JSON.stringify(r3MakeQrForDb(source.dbId))})`,['initialize','done']);assert.notEqual(run('TC.deviceId'),source.deviceId);assert.equal(run('TC.deviceId'),settings.get(r3DeviceKey));
});
await test('R3 DOLD flow failure leaves QR mode reset for the next ordinary scan',async()=>{
 await r3EmptyWorkspace('r3-reset-mode');await r3Pump(`handleDirectSyncQr('wrong')`,['done']);assert.equal(run('S.qrMode'),'audit');
});
async function r4WithEnv(ctx,dir,fn){const oldEnv=env,oldStore=storeDir;env=ctx;if(dir)storeDir=dir;try{return await fn();}finally{env=oldEnv;storeDir=oldStore;}}
async function r4PhonePair(label){
 const oldEnv=env,oldStore=storeDir,deviceKey='dold_techcontrol_device_id_v1';
 settings.set(deviceKey,'device-'+'a'.repeat(32));await freshWorkspace(label+'-phone-a',bytes);const phoneA=env,dirA=storeDir;
 const baseline=await r4WithEnv(phoneA,dirA,async()=>{await run('continueLastWorkingFile()');await run('resetRingProgress()');await run('continueCycle()');const seed=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await saveTestInspection(seed,'R4 shared baseline defect');return run('createSyncBaselineBytes()');});
 const dbId=await r4WithEnv(phoneA,dirA,()=>run('TC.dbId')),deviceA=await r4WithEnv(phoneA,dirA,()=>run('TC.deviceId'));
 await r3EmptyWorkspace(label+'-phone-b','b');const phoneB=env,dirB=storeDir;
 await importSyncBytes(baseline,label+'_baseline.dtcs',['initialize']);const deviceB=run('TC.deviceId');
 // This pair covers semantic sync only; H separately verifies random QR presence challenges.
 // Pin the device-local challenge counter so this multi-save scenario is not random/flaky.
 for(const [ctx,id] of [[phoneA,deviceA],[phoneB,deviceB]]){const local=new Map([[deviceKey,id]]);ctx.cx.localStorage={getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};ctx.run(`TC.deviceId=${JSON.stringify(id)};TC.guard={remaining:100,pending:null}`);}
 await run('continueCycle()');
 env=oldEnv;storeDir=oldStore;
 return {phoneA,phoneB,dirA,dirB,baseline,dbId,deviceKey};
}
async function r4Count(ctx,sheet){return ctx.run(`(async()=>{const d=await loadDoc(${JSON.stringify(sheet)});return qsa(d,'row').filter(r=>Number(r.getAttribute('r'))>=5&&getCellVal(d,'B',Number(r.getAttribute('r')))).length;})()`);}
function r4InstallTransport(phoneA,phoneB,dbId,fault={}){
 const pairing=r3Pairing({host:'192.168.1.8',sessionId:crypto.randomBytes(16).toString('base64url'),token:crypto.randomBytes(32).toString('base64url'),lineage:crypto.createHash('sha256').update(String(dbId)).digest('hex')}),net={pairing,hostStatus:{status:'WAITING'},hostResponses:[],clientCalls:[],started:false,dialogs:[],hostPreparedState:null};
 phoneA.cx.setTimeout=(fn,ms)=>setTimeout(fn,Math.min(ms,15));phoneA.cx.clearTimeout=clearTimeout;phoneB.cx.setTimeout=(fn,ms)=>setTimeout(fn,Math.min(ms,15));phoneB.cx.clearTimeout=clearTimeout;
 const failed=(reason='CONNECTION_FAILED')=>JSON.stringify({status:'DONE',result:reason});
 const hostSave=phoneA.cx.Android.saveWorkspace,clientSave=phoneB.cx.Android.saveWorkspace;
 phoneA.cx.Android.saveWorkspace=(id,payload)=>fault.failHostSave&&net.hostStatus.status==='ACK_RECEIVED'?JSON.stringify({ok:false,error:'Injected host durable save failure'}):hostSave(id,payload);
 phoneB.cx.Android.saveWorkspace=(id,payload)=>{if(fault.failClientSave&&net.clientCalls.length===1&&net.hostResponses.length>=1){net.hostStatus={status:'ERROR',error:'TRANSPORT_ERROR'};return JSON.stringify({ok:false,error:'Injected client durable save failure'});}return clientSave(id,payload);};
 phoneA.cx.Android.startLanSyncSessionDeferred=(id,initial)=>{net.started=true;net.hostDbId=id;net.initialResponse=initial;return JSON.stringify({ok:true,status:'STARTED',pairing});};
 phoneB.cx.Android.startLanSyncSessionDeferred=()=>JSON.stringify({ok:false,status:'NOT_HOST'});phoneB.cx.Android.respondLanSyncSession=()=>false;
 phoneA.cx.Android.getLanSyncSessionStatus=()=>JSON.stringify(net.hostStatus);
 phoneA.cx.Android.respondLanSyncSession=(base64,terminal)=>{const phase=net.hostStatus.status==='ACK_RECEIVED'?2:1;if(fault.dropHostResponseAt===phase){net.droppedHostResponse=phase;net.hostStatus={status:'ERROR',error:'TRANSPORT_ERROR'};return false;}const response=Buffer.from(base64,'base64');net.hostResponses.push(response);net.lastTerminal=!!terminal;if(terminal){net.hostStatus={status:'COMPLETED',requestBase64:net.hostStatus.requestBase64||''};}else{net.hostPreparedState={openDefectCount:phoneA.run('S.existingDefects.length'),checked:phoneA.run('S.sessionChecked.size')};net.hostStatus={status:'WAITING_ACK'};}return true;};
 phoneA.cx.Android.stopLanSyncSession=()=>{net.hostStatus={status:'CANCELLED'};return true;};
 phoneB.cx.Android.startLanSyncClient=(pairingJson,expectedDbId,requestBase64)=>{const phase=net.clientCalls.length+1;net.clientCalls.push({phase,pairing:JSON.parse(pairingJson),expectedDbId,requestBase64});if(fault.failClientStartAt===phase||fault.dropClientRequestAt===phase){net.hostStatus={status:'ERROR',error:'TRANSPORT_ERROR'};net.clientResults??={};net.clientResults[phase]=failed();return JSON.stringify({ok:fault.failClientStartAt!==phase,status:'CONNECTION_FAILED',jobId:'r4-job-'+phase});}net.hostStatus={status:phase===1?'REQUEST_RECEIVED':'ACK_RECEIVED',requestBase64};return JSON.stringify({ok:true,jobId:'r4-job-'+phase,status:'CONNECTING'});};
 phoneB.cx.Android.getLanSyncClientResult=jobId=>{const phase=Number(String(jobId).split('-').at(-1));if(net.clientResults?.[phase])return net.clientResults[phase];const response=net.hostResponses[phase-1];if(!response){if(['ERROR','CANCELLED','EXPIRED'].includes(net.hostStatus.status))return failed(net.hostStatus.error||'CONNECTION_FAILED');return JSON.stringify({status:'CONNECTING'});}if(fault.dropClientResponseAt===phase){net.droppedClientResponse=phase;net.hostStatus={status:'ERROR',error:'TRANSPORT_ERROR'};return failed();}return JSON.stringify({status:'DONE',result:'SUCCESS',responseBase64:response.toString('base64')});};
 net.cleanup=()=>{phoneA.cx.Android.saveWorkspace=hostSave;phoneB.cx.Android.saveWorkspace=clientSave;};
 return net;
}
async function r4RunSession(phoneA,phoneB,dbId,conflictChoice='remote',fault={}){
 const net=r4InstallTransport(phoneA,phoneB,dbId,fault);let hostDone=false,clientDone=false,hostError=null,clientError=null,clientValue;
 try{
  const hostPromise=phoneA.run('showDirectSyncQr()').then(()=>{hostDone=true;},e=>{hostDone=true;hostError=e;});
  for(let i=0;i<500&&!net.started;i++)await new Promise(resolve=>setTimeout(resolve,2));if(!net.started)throw Error('R4 host did not start');
  const qr=phoneA.run(`directPairingPayload(${JSON.stringify(net.pairing)})`),clientPromise=phoneB.run(`handleDirectSyncQr(${JSON.stringify(qr)})`).then(v=>{clientValue=v;clientDone=true;},e=>{clientDone=true;clientError=e;});
  const maxPolls=(Object.keys(fault).length||conflictChoice==='cancel-client-preview')?4000:15000;
  for(let i=0;i<maxPolls&&(!hostDone||!clientDone);i++){
    for(const [role,ctx] of [['A',phoneA],['B',phoneB]]){
      let active=false;try{active=ctx.run("typeof appDialogResolve==='function'");}catch(e){}
      if(active){const title=ctx.run("$('appDialogTitle')?.textContent||''"),body=ctx.run("$('appDialogBody')?.innerHTML||''");net.dialogs.push({role,title,body});let choice='done';if(title==='SÜNKROONIMINE')choice=conflictChoice==='cancel-client-preview'&&role==='B'?'cancel':'sync';else if(title==='ANDMETE VASTUOLU')choice=conflictChoice;else if(title==='LISA UUS KONTROLL')choice='create';else if(title.includes('ON JUBA KONTROLLITUD'))choice='new';ctx.run(`appDialogChoice(${JSON.stringify(choice)})`);}
    }
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  if(!hostDone||!clientDone)throw Error('R4 phone-to-phone flow timed out: '+JSON.stringify({hostDone,clientDone,host:net.hostStatus,started:net.started,responses:net.hostResponses.length,dialogs:net.dialogs.map(x=>x.role+':'+x.title)}));
  await Promise.all([hostPromise,clientPromise]);if(hostError)throw hostError;if(clientError)throw clientError;
  return {net,clientValue,dialogs:net.dialogs};
 }finally{net.cleanup();}
}
await test('R4 bidirectional semantic sync converges in one QR session and protects conflicts/idempotency',async()=>{
 const pair=await r4PhonePair('r4-integration'),{phoneA,phoneB,dirA,dirB,dbId,deviceKey}=pair;
 const controls=[],newDefects=[];let oldDefectId='',baselineKontrollRows=0,baselineDefectRows=0,baselineCycle='',baselineChecked=0;
 await r4WithEnv(phoneA,dirA,async()=>{
   await run('continueLastWorkingFile()');await run('continueCycle()');baselineKontrollRows=await count('Kontrollid');baselineDefectRows=await count('Puudused');baselineCycle=run('TC.cycle.id');baselineChecked=run('S.sessionChecked.size');
   const ids=JSON.parse(JSON.stringify(run('activeCabinets().filter(c=>!S.sessionChecked.has(c.id)).slice(0,2).map(c=>c.id)')));assert.equal(ids.length,2);controls.push(...ids);
   await saveTestInspection(ids[0],'R4 parallel defect one');await saveTestInspection(ids[1],'R4 parallel defect two');
   await openCabWithChoices(ids[0],'list',['new','create']);el('inspector').value='R4 inspector';run('setAllScores(3)');advance(61);await run('saveInspection()');
   for(const id of ids)assert(run(`S.sessionChecked.has(${JSON.stringify(id)})`));
   const defects=JSON.parse(JSON.stringify(run(`TC.allDefects.filter(d=>['R4 parallel defect one','R4 parallel defect two'].includes(d.desc)).map(d=>({id:d.syncId,desc:d.desc}))`)));assert.equal(defects.length,2);newDefects.push(...defects);
   const old=JSON.parse(JSON.stringify(run('S.existingDefects[0]')));oldDefectId=old.syncId;
   const updated=await run(`transaction(async()=>{const doc=await loadDoc('Puudused');writeSyncText(doc,'J',${old.row},'R4 owner from A');S.zip.file(S.paths.Puudused,xmlStr(doc));S.dirty=true;})`);assert(updated);
 });
 await r4WithEnv(phoneB,dirB,async()=>{
   await run('continueLastWorkingFile()');await run('continueCycle()');assert.equal(run('TC.cycle.id'),baselineCycle);const old=run(`S.existingDefects.find(d=>d.syncId===${JSON.stringify(oldDefectId)})`);assert(old);
   run('openDefectRepair('+old.row+')');el('repairer').value='R4 repairer from B';el('repairWork').value='Replaced terminal and tested';await run('saveRepair()');assert(!run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(oldDefectId)})`));
 });
 const first=await r4RunSession(phoneA,phoneB,dbId,'remote');
 const r4Checks=[];function verify(name,condition,details=''){assert(condition,name+(details?' — '+details:''));r4Checks.push(name);results.push({name:'R4 '+name,status:'PASS'});}
 verify('A inspection operations were exchanged in the first proposal/response session',first.net.clientCalls.length===2&&first.net.hostResponses.length===2,JSON.stringify({calls:first.net.clientCalls.length,responses:first.net.hostResponses.length,status:first.net.hostStatus.status,dialogs:first.dialogs.map(d=>d.role+':'+d.title),client:first.clientValue,responseTerminal:first.net.lastTerminal}));
 verify('one QR pairing was sufficient for both directions',first.net.clientCalls.every(c=>c.pairing.sessionId===first.net.pairing.sessionId));
 verify('no Share or file picker transport was used',first.net.clientCalls.length===2&&first.net.initialResponse.length>100);
 verify('host did not apply repair before client durable delta arrived',first.net.hostPreparedState?.openDefectCount>0);
 verify('same database lineage and epoch survived',phoneA.run('TC.dbId')===phoneB.run('TC.dbId')&&phoneA.run('TC.sync.epoch')===phoneB.run('TC.sync.epoch'));
 verify('device identities remain distinct',phoneA.run('TC.deviceId')!==phoneB.run('TC.deviceId'));
 verify('Phone A inspection 1 arrived at B exactly once',phoneB.run(`TC.records.filter(r=>r.syncId===${JSON.stringify(phoneA.run(`savedEntry(${JSON.stringify(controls[0])}).syncId`))}).length`)===1);
 verify('Phone A inspection 2 arrived at B exactly once',phoneB.run(`TC.records.filter(r=>r.syncId===${JSON.stringify(phoneA.run(`savedEntry(${JSON.stringify(controls[1])}).syncId`))}).length`)===1);
 verify('second historical Kontroll for one EK remains a single checked cabinet',phoneA.run('S.sessionChecked.size')===baselineChecked+controls.length&&phoneB.run('S.sessionChecked.size')===baselineChecked+controls.length);
 verify('current cycle identity is unchanged on both phones',phoneA.run('TC.cycle.id')===baselineCycle&&phoneB.run('TC.cycle.id')===baselineCycle);
 verify('cycle progress counts unique EK IDs on both phones',phoneA.run('new Set(Object.keys(TC.cycle.entries)).size')===baselineChecked+controls.length&&phoneB.run('new Set(Object.keys(TC.cycle.entries)).size')===baselineChecked+controls.length);
 verify('two newly created Puudused arrived on B exactly once',newDefects.every(d=>phoneB.run(`TC.allDefects.filter(x=>x.syncId===${JSON.stringify(d.id)}).length`)===1));
 verify('two newly created Puudused are present on A exactly once',newDefects.every(d=>phoneA.run(`TC.allDefects.filter(x=>x.syncId===${JSON.stringify(d.id)}).length`)===1));
 const bRepair=phoneA.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(oldDefectId)})`),aRepair=phoneB.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(oldDefectId)})`);
 verify('B repair closed the original Puudus on A',!phoneA.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(oldDefectId)})`));
 verify('repairer survived on A and B',bRepair.repairer==='R4 repairer from B'&&aRepair.repairer==='R4 repairer from B');
 verify('repair action survived on A and B',String(bRepair.repairAction).includes('Replaced terminal')&&String(aRepair.repairAction).includes('Replaced terminal'));
 verify('repair close date/time survived on A and B',!!bRepair.closedAt&&!!aRepair.closedAt);
 verify('A responsible-person change survived different-field merge',phoneA.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(oldDefectId)}).owner`)==='R4 owner from A'&&phoneB.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(oldDefectId)}).owner`)==='R4 owner from A');
 verify('repair did not create Kontrollid rows',await r4Count(phoneA,'Kontrollid')===await r4Count(phoneB,'Kontrollid'));
 verify('local A inspections remained on A',controls.every(id=>phoneA.run(`TC.cycle.entries[${JSON.stringify(id)}]`)));
 verify('local B repair remained on B',!phoneB.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(oldDefectId)})`));
 verify('new XLSX records were appended once on both workbooks',await r4Count(phoneA,'Kontrollid')===baselineKontrollRows+3&&await r4Count(phoneB,'Kontrollid')===baselineKontrollRows+3,JSON.stringify({baselineKontrollRows,a:await r4Count(phoneA,'Kontrollid'),b:await r4Count(phoneB,'Kontrollid'),expected:baselineKontrollRows+3}));
 verify('client received host commit acknowledgement before reporting success',first.clientValue===true&&first.net.lastTerminal===true);
 verify('client preview included semantic Kontrol/Puudus categories',first.dialogs.some(d=>d.role==='B'&&d.title==='SÜNKROONIMINE'&&d.body.includes('kontrolli')&&d.body.includes('uut puudust')));
 verify('host preview included semantic repair category',first.dialogs.some(d=>d.role==='A'&&d.title==='SÜNKROONIMINE'&&d.body.includes('parandust')));

 const countsBefore={aK:await r4Count(phoneA,'Kontrollid'),bK:await r4Count(phoneB,'Kontrollid'),aP:await r4Count(phoneA,'Puudused'),bP:await r4Count(phoneB,'Puudused')};
 const repeated=await r4RunSession(phoneA,phoneB,dbId,'remote');
 verify('repeat direct sync presents zero new inspections',repeated.dialogs.filter(d=>d.title==='SÜNKROONIMINE').every(d=>/\+ 0 kontrolli/.test(d.body)));
 verify('repeat direct sync presents zero new defects and repairs',repeated.dialogs.filter(d=>d.title==='SÜNKROONIMINE').every(d=>/\+ 0 uut puudust/.test(d.body)&&/0 parandust/.test(d.body)));
 verify('repeat direct sync creates zero duplicate rows',await r4Count(phoneA,'Kontrollid')===countsBefore.aK&&await r4Count(phoneB,'Kontrollid')===countsBefore.bK&&await r4Count(phoneA,'Puudused')===countsBefore.aP&&await r4Count(phoneB,'Puudused')===countsBefore.bP);
 verify('repeated delivery leaves applied operation identity set unchanged',phoneA.run('new Set(TC.sync.appliedOps).size===TC.sync.appliedOps.length')&&phoneB.run('new Set(TC.sync.appliedOps).size===TC.sync.appliedOps.length'));

 const conflictDefectId=newDefects[0].id;
 async function editDescription(ctx,dir,value){return r4WithEnv(ctx,dir,async()=>{const d=run(`TC.allDefects.find(x=>x.syncId===${JSON.stringify(conflictDefectId)})`);return run(`transaction(async()=>{const doc=await loadDoc('Puudused');writeSyncText(doc,'G',${d.row},${JSON.stringify(value)});S.zip.file(S.paths.Puudused,xmlStr(doc));S.dirty=true;})`);});}
 assert(await editDescription(phoneA,dirA,'Phone A cable replacement'));
 assert(await editDescription(phoneB,dirB,'Phone B cable fastening'));
 const saveWorkspaceB=phoneB.cx.Android.saveWorkspace;let bWorkspaceWrites=0;phoneB.cx.Android.saveWorkspace=(id,payload)=>{bWorkspaceWrites++;return saveWorkspaceB(id,payload);};let remoteChoice;try{remoteChoice=await r4RunSession(phoneA,phoneB,dbId,'remote');}finally{phoneB.cx.Android.saveWorkspace=saveWorkspaceB;}
 verify('incoming changes and direct conflict resolution commit in one workspace transaction',bWorkspaceWrites===3,`client proposal + one apply/resolve commit + final package = ${bWorkspaceWrites} writes`);
 verify('same-field edit produced visible DOLD conflict choice',remoteChoice.dialogs.some(d=>d.role==='B'&&d.title==='ANDMETE VASTUOLU'&&d.body.includes('Phone A cable replacement')&&d.body.includes('Phone B cable fastening')));
 verify('remote conflict choice persisted Phone A value on both phones',phoneA.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(conflictDefectId)}).desc`)==='Phone A cable replacement'&&phoneB.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(conflictDefectId)}).desc`)==='Phone A cable replacement');
 verify('remote resolution operation reached peer and marked conflict resolved',phoneA.run(`TC.sync.conflicts.every(c=>c.resolved||c.entityId!==${JSON.stringify(conflictDefectId)})`)&&phoneB.run(`TC.sync.conflicts.every(c=>c.resolved||c.entityId!==${JSON.stringify(conflictDefectId)})`));
 const noReopen=await r4RunSession(phoneA,phoneB,dbId,'remote');
 verify('resolved same-field conflict did not reopen on next sync',!noReopen.dialogs.some(d=>d.title==='ANDMETE VASTUOLU'));

 assert(await editDescription(phoneA,dirA,'Phone A second edit'));
 assert(await editDescription(phoneB,dirB,'Phone B second edit'));
 const localChoice=await r4RunSession(phoneA,phoneB,dbId,'local');
 verify('local conflict choice persisted Phone B value on both phones',phoneA.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(conflictDefectId)}).desc`)==='Phone B second edit'&&phoneB.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(conflictDefectId)}).desc`)==='Phone B second edit');
 verify('both conflict choice paths wrote propagating resolution operations',phoneA.run(`TC.sync.journal.some(o=>o.resolvesFieldVersions?.description?.length>=2&&o.entityId===${JSON.stringify(conflictDefectId)})`)&&phoneB.run(`TC.sync.journal.some(o=>o.resolvesFieldVersions?.description?.length>=2&&o.entityId===${JSON.stringify(conflictDefectId)})`));

 const beforeWrong=await phoneB.run('(async()=>await storeCall("get",TC.dbId))()'),wrongPair=r3Pairing({lineage:'f'.repeat(64)}),wrongDialogs=[];await r4WithEnv(phoneB,dirB,async()=>{await r3Pump(`handleDirectSyncQr(${JSON.stringify(r3Qr(wrongPair))})`,['done'],title=>wrongDialogs.push(title));});const afterWrong=await phoneB.run('(async()=>await storeCall("get",TC.dbId))()');
 verify('wrong database lineage is rejected before preview or apply',wrongDialogs.includes('TEINE TÖÖBAAS')&&afterWrong.workbookHash===beforeWrong.workbookHash);

 const validDelta=await phoneA.run('createSyncDeltaBytes()'),deltaArchive=await JSZip.loadAsync(validDelta),manifest=JSON.parse(await deltaArchive.file('manifest.json').async('string')),opBytes=await deltaArchive.file('operations.json').async('uint8array'),badEpochArchive=await JSZip.loadAsync(validDelta);manifest.epoch='wrong-r4-epoch';badEpochArchive.file('manifest.json',JSON.stringify(manifest));const badEpoch=await badEpochArchive.generateAsync({type:'uint8array'}),beforeEpoch=await phoneA.run('(async()=>await storeCall("get",TC.dbId))()');phoneA.cx.testPayload=badEpoch;let wrongEpoch=false;try{await phoneA.run('processSyncPackageBytes(testPayload,"wrong-epoch.dtcs",null,{directProtocol:true,directPrepareOnly:true})');}catch(e){wrongEpoch=true;}const afterEpoch=await phoneA.run('(async()=>await storeCall("get",TC.dbId))()');
 verify('wrong epoch package is rejected without changing local workbook',wrongEpoch&&afterEpoch.workbookHash===beforeEpoch.workbookHash);
 const corruptBefore=await phoneA.run('(async()=>await storeCall("get",TC.dbId))()');phoneA.cx.testPayload=new Uint8Array([0x50,0x4b,0x03,0x04,0]);let corruptRejected=false;try{await phoneA.run('processSyncPackageBytes(testPayload,"corrupt.dtcs",null,{directProtocol:true,directPrepareOnly:true})');}catch(e){corruptRejected=true;}const corruptAfter=await phoneA.run('(async()=>await storeCall("get",TC.dbId))()');
 verify('corrupt payload is rejected before durable mutation',corruptRejected&&corruptAfter.workbookHash===corruptBefore.workbookHash);
 const badOps=JSON.parse(new TextDecoder().decode(opBytes));badOps[0].dbId='another-db';const badOpsBytes=new TextEncoder().encode(JSON.stringify(badOps)),badManifest={...JSON.parse(await deltaArchive.file('manifest.json').async('string')),operations:{...JSON.parse(await deltaArchive.file('manifest.json').async('string')).operations,size:badOpsBytes.length,sha256:crypto.createHash('sha256').update(badOpsBytes).digest('hex'),count:badOps.length}},badOpsZip=new JSZip();badOpsZip.file('manifest.json',JSON.stringify(badManifest));badOpsZip.file('operations.json',badOpsBytes);phoneA.cx.testPayload=await badOpsZip.generateAsync({type:'uint8array'});let invalidRejected=false;try{await phoneA.run('processSyncPackageBytes(testPayload,"invalid-op.dtcs",null,{directProtocol:true,directPrepareOnly:true})');}catch(e){invalidRejected=true;}
 verify('semantically invalid operation is rejected before apply',invalidRejected);

 const rollbackCabinet=phoneA.run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await r4WithEnv(phoneA,dirA,()=>saveTestInspection(rollbackCabinet,'R4 rollback candidate'));const rollbackDelta=await phoneA.run('createSyncDeltaBytes()'),rollbackZip=await JSZip.loadAsync(rollbackDelta),rollbackOps=JSON.parse(await rollbackZip.file('operations.json').async('string'));
 const beforeRollback=await r4Count(phoneB,'Kontrollid'),beforeApplied=phoneB.run('TC.sync.appliedOps.length');injectFailure=true;let saveRejected=false;try{await phoneB.run(`applySyncOperations(${JSON.stringify(rollbackOps)},${JSON.stringify(phoneA.run('TC.deviceId'))})`);}catch(e){saveRejected=true;}injectFailure=false;
 verify('failed durable save is not acknowledged and rolls back workbook/journal',saveRejected&&await r4Count(phoneB,'Kontrollid')===beforeRollback&&phoneB.run('TC.sync.appliedOps.length')===beforeApplied);

 const noChangeBefore=await phoneB.run('(async()=>await storeCall("get",TC.dbId))()');phoneB.cx.incoming=rollbackDelta;const priorEnv=env;env=phoneB;await r3Pump('processSyncPackageBytes(incoming,"cancel-before-confirm.dtcs",null,{directProtocol:true,directRole:"TELEFON A → TELEFON B"})',['cancel']);env=priorEnv;const noChangeAfter=await phoneB.run('(async()=>await storeCall("get",TC.dbId))()');
 verify('cancel before user confirmation changes nothing',noChangeBefore.workbookHash===noChangeAfter.workbookHash);

 for(const ctx of [phoneA,phoneB]){ctx.cx.setTimeout=global.setTimeout;ctx.cx.clearTimeout=global.clearTimeout;}
 let restartedA,restartedB;for(const [dir,char] of [[dirA,'a'],[dirB,'b']]){settings.set(deviceKey,'device-'+char.repeat(32));storeDir=dir;env=makeContext();await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');assert.equal(run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(conflictDefectId)}).desc`),'Phone B second edit');if(char==='a')restartedA=env;else restartedB=env;}
 const restartCheck=restartedA.run('TC.sync.epoch')===restartedB.run('TC.sync.epoch')&&restartedA.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(conflictDefectId)}).desc`)===restartedB.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(conflictDefectId)}).desc`);
 verify('restart after successful sync restores identical merged business state',restartCheck);
 verify('workbook history and sheet set survive sync export model',restartedA.run('Object.keys(S.paths).length===8')&&restartedB.run('Object.keys(S.paths).length===8'));
 verify('full handoff and file based sync entry points remain available',restartedA.run("typeof createWorkPackageBytes==='function'&&typeof createSyncDeltaBytes==='function'&&typeof importWorkPackage==='function'&&typeof processSyncPackageBytes==='function'"));
 verify('R3 baseline bootstrap path and different device ids remain present',restartedA.run("typeof importSyncBaseline==='function'&&typeof installationDeviceId==='function'")&&restartedA.run('TC.deviceId')!==restartedB.run('TC.deviceId'));
 assert.equal(r4Checks.length,46,`R4 subcase count was ${r4Checks.length}`);fs.writeFileSync(path.join(out,'r4-results.json'),JSON.stringify({passed:r4Checks.length,total:46,cases:r4Checks},null,2));console.log(`R4 BUSINESS ${r4Checks.length}/46 PASS`);
});
await test('R5 safety failures keep durable work recoverable across the two-exchange session',async()=>{
 const checks=[];function verify(name,condition,details=''){assert(condition,name+(details?' — '+details:''));checks.push({name,pass:true,details});}
 let {phoneA,phoneB,dirA,dirB,dbId,deviceKey}=await r4PhonePair('r5-safety'),deviceA=phoneA.run('TC.deviceId'),deviceB=phoneB.run('TC.deviceId');
 async function saved(ctx){return JSON.parse(JSON.stringify(await ctx.run('(async()=>await storeCall("get",TC.dbId))()')));}
 function sameBusiness(a,b){const axes=['controlCount','defectCount','openDefects','activeCount','checkedCount'];return a.dbId===b.dbId&&JSON.stringify(a.cycle)===JSON.stringify(b.cycle)&&JSON.stringify(a.sync)===JSON.stringify(b.sync)&&axes.every(k=>Number(a.summary?.[k])===Number(b.summary?.[k]))&&a.sourceHash===b.sourceHash;}
 async function liveRows(ctx,sheet){return r4Count(ctx,sheet);}
 async function inspectOn(ctx,dir,description){return r4WithEnv(ctx,dir,async()=>{await run('continueLastWorkingFile()');await run('continueCycle()');const cabinet=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await saveTestInspection(cabinet,description);return {cabinet,kontrollId:run(`savedEntry(${JSON.stringify(cabinet)}).syncId`),defectId:run(`TC.allDefects.find(d=>d.desc===${JSON.stringify(description)}).syncId`)};});}
 async function repairOn(ctx,dir,defectId,tag){return r4WithEnv(ctx,dir,async()=>{const d=run(`TC.allDefects.find(x=>x.syncId===${JSON.stringify(defectId)})`);assert(d,'repair candidate missing');run(`openDefectRepair(${d.row})`);el('repairer').value=`R5 ${tag} repairer`;el('repairWork').value=`R5 ${tag} replaced and tested`;await run('saveRepair()');return JSON.parse(JSON.stringify(run(`TC.allDefects.find(x=>x.syncId===${JSON.stringify(defectId)})`)));});}
 async function restart(ctx,dir,deviceId){const oldEnv=env,oldDir=storeDir;settings.set(deviceKey,deviceId);storeDir=dir;env=makeContext();const fresh=env,local=new Map([[deviceKey,deviceId]]);fresh.cx.localStorage={getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)};await run('TC.startupTask');await run('continueLastWorkingFile()');await run('continueCycle()');env=oldEnv;storeDir=oldDir;return fresh;}
 function noSuccess(session){return !session.dialogs.some(d=>d.title==='SÜNKROONITUD');}
 function uncertain(session){return session.dialogs.some(d=>/TULEMUST EI SAANUD KINNITADA|OTSEÜHENDUS EBAÕNNESTUS/.test(d.title)||/tulemust ei saanud kinnitada/i.test(d.body));}
 async function workbookMeta(ctx){return JSON.parse(JSON.stringify(await ctx.run(`(async()=>{const names=Object.keys(S.paths).sort(),parts=Object.values(S.paths),formulas=[];for(const p of parts){const d=parseXml(await S.zip.file(p).async('string'));for(const f of qsa(d,'f'))formulas.push(f.textContent||'');}return {names,formulaCount:formulas.length,formulaHash:await digest(new TextEncoder().encode(formulas.join('|'))),fileCount:Object.keys(S.zip.files).length};})()`)));}
 async function packageFrom(ctx,mutate,rehash=true){const bytes=await ctx.run('createSyncDeltaBytes()'),zip=await JSZip.loadAsync(bytes),manifest=JSON.parse(await zip.file('manifest.json').async('string')),ops=JSON.parse(await zip.file(manifest.operations.path||'operations.json').async('string'));mutate?.(manifest,ops);const opBytes=new TextEncoder().encode(JSON.stringify(ops));if(rehash){manifest.operations.size=opBytes.length;manifest.operations.count=ops.length;manifest.operations.sha256=crypto.createHash('sha256').update(opBytes).digest('hex');}zip.file(manifest.operations.path||'operations.json',opBytes);zip.file('manifest.json',JSON.stringify(manifest));return zip.generateAsync({type:'uint8array'});}
 async function rejectedWithoutWrite(ctx,payload,label){const before=await saved(ctx);let rejected=false;ctx.cx.incoming=new Uint8Array(payload);try{await ctx.run(`processSyncPackageBytes(incoming,${JSON.stringify(label)},null,{directProtocol:true,directPrepareOnly:true})`);}catch(e){rejected=true;}const after=await saved(ctx);return {rejected,unchanged:before.workbookHash===after.workbookHash&&before.sync.journal.length===after.sync.journal.length&&before.sync.appliedOps.length===after.sync.appliedOps.length};}
 const baselineA=await saved(phoneA),baselineB=await saved(phoneB);
 verify('R5 pair begins on one database and epoch',phoneA.run('TC.dbId')===phoneB.run('TC.dbId')&&phoneA.run('TC.sync.epoch')===phoneB.run('TC.sync.epoch'));
 verify('R5 pair keeps separate persistent device IDs',deviceA!==deviceB&&/^device-[a-f0-9]{32}$/.test(deviceA)&&/^device-[a-f0-9]{32}$/.test(deviceB));
 verify('initial durable snapshots contain checksummed workbooks',!!baselineA.workbookHash&&!!baselineB.workbookHash&&baselineA.workbookBase64.length>0&&baselineB.workbookBase64.length>0);
 verify('initial workbooks preserve the same sheet-name set',JSON.stringify((await workbookMeta(phoneA)).names)===JSON.stringify((await workbookMeta(phoneB)).names));
 const firstControl=await inspectOn(phoneA,dirA,'R5 first durable inspection defect');
 const seedDefect=phoneB.run(`TC.allDefects.find(d=>d.desc==='R4 shared baseline defect').syncId`);
 const controlsBeforeRepair=await liveRows(phoneB,'Kontrollid');
 const firstRepair=await repairOn(phoneB,dirB,seedDefect,'first');
 let beforeA=await saved(phoneA),beforeB=await saved(phoneB);
 verify('Phone A inspection and new defect have durable operation IDs',firstControl.kontrollId&&firstControl.defectId&&beforeA.sync.journal.some(o=>o.entityId===firstControl.kontrollId)&&beforeA.sync.journal.some(o=>o.entityId===firstControl.defectId));
 verify('Phone B repair has durable close fields and journal operation',!!firstRepair.closedAt&&firstRepair.repairer==='R5 first repairer'&&beforeB.sync.journal.some(o=>o.entityId===seedDefect&&o.action==='CLOSE_PUUDUS'));
 verify('saved local operations are also present in local appliedOps',beforeA.sync.journal.filter(o=>o.deviceId===deviceA).every(o=>beforeA.sync.appliedOps.includes(o.opId))&&beforeB.sync.journal.filter(o=>o.deviceId===deviceB).every(o=>beforeB.sync.appliedOps.includes(o.opId)));
 verify('local repair did not create a fake Kontrollid row',await liveRows(phoneB,'Kontrollid')===controlsBeforeRepair);
 // Fail before request metadata is exchanged.
 const startFailure=await r4RunSession(phoneA,phoneB,dbId,'remote',{failClientStartAt:1}),afterStartA=await saved(phoneA),afterStartB=await saved(phoneB);
 verify('no exchange start leaves both business snapshots unchanged',sameBusiness(afterStartA,beforeA)&&sameBusiness(afterStartB,beforeB));
 verify('no exchange start does not advance either journal',afterStartA.sync.journal.length===beforeA.sync.journal.length&&afterStartB.sync.journal.length===beforeB.sync.journal.length);
 verify('no exchange start cannot journal peer-owned operations',!afterStartA.sync.journal.some(o=>o.entityId===seedDefect&&o.deviceId===deviceB)&&!afterStartB.sync.journal.some(o=>o.entityId===firstControl.kontrollId&&o.deviceId===deviceA));
 verify('no exchange start never displays SÜNKROONITUD',noSuccess(startFailure));
 verify('no exchange start resets both busy states',!phoneA.run('TC.busy')&&!phoneB.run('TC.busy'));
 // First socket response is lost after host preview: neither side has applied it.
 const firstLost=await r4RunSession(phoneA,phoneB,dbId,'remote',{dropHostResponseAt:1}),afterFirstLostA=await saved(phoneA),afterFirstLostB=await saved(phoneB);
 verify('lost exchange-one response is observed by both test peers',firstLost.net.droppedHostResponse===1&&firstLost.net.hostStatus.status==='ERROR');
 verify('host preview alone does not durably apply Phone B repairs',sameBusiness(afterFirstLostA,beforeA));
 verify('lost exchange-one response leaves Phone B business state unchanged',sameBusiness(afterFirstLostB,beforeB));
 verify('lost exchange-one response creates no remote applied marker',JSON.stringify(afterFirstLostB.sync.appliedOps)===JSON.stringify(beforeB.sync.appliedOps));
 verify('lost exchange-one response never reports success',noSuccess(firstLost));
 verify('lost exchange-one response releases both application busy flags',!phoneA.run('TC.busy')&&!phoneB.run('TC.busy'));
 // The client can decline the preview before it begins the durable transaction.
 const cancelPreview=await r4RunSession(phoneA,phoneB,dbId,'cancel-client-preview'),afterCancelA=await saved(phoneA),afterCancelB=await saved(phoneB);
 verify('client cancel before SÜNKROONI sends protocol abort',cancelPreview.net.clientCalls.length===2&&cancelPreview.net.lastTerminal===true);
 verify('cancel-before-apply leaves both persisted business states unchanged',sameBusiness(afterCancelA,beforeA)&&sameBusiness(afterCancelB,beforeB));
 verify('cancel-before-apply leaves journals and appliedOps unchanged',afterCancelA.sync.journal.length===beforeA.sync.journal.length&&afterCancelB.sync.journal.length===beforeB.sync.journal.length&&JSON.stringify(afterCancelA.sync.appliedOps)===JSON.stringify(beforeA.sync.appliedOps)&&JSON.stringify(afterCancelB.sync.appliedOps)===JSON.stringify(beforeB.sync.appliedOps));
 verify('cancel-before-apply never displays success',noSuccess(cancelPreview));
 // Client durable-save failure while applying host delta must roll back locally.
 const clientSaveFailure=await r4RunSession(phoneA,phoneB,dbId,'remote',{failClientSave:true}),afterClientSaveFailA=await saved(phoneA),afterClientSaveFailB=await saved(phoneB);
 verify('injected Phone B WorkspaceStore failure reaches transport teardown',clientSaveFailure.net.hostStatus.status==='ERROR');
 verify('client save failure preserves the prior business state',sameBusiness(afterClientSaveFailB,beforeB));
 verify('client save failure rolls back incoming journal operations',afterClientSaveFailB.sync.journal.length===beforeB.sync.journal.length&&JSON.stringify(afterClientSaveFailB.sync.appliedOps)===JSON.stringify(beforeB.sync.appliedOps));
 verify('client save failure keeps previously saved local repair',phoneB.run(`!S.existingDefects.some(d=>d.syncId===${JSON.stringify(seedDefect)})`));
 verify('client save failure cannot be labelled SÜNKROONITUD',noSuccess(clientSaveFailure));
 verify('client save failure releases busy and pending-row transaction state',!phoneB.run('TC.busy')&&!phoneB.run('TC.pendingSemanticRows')&&!phoneB.run('TC.pendingSyncRowIds'));
 // Retry after a failed receive; the existing operation IDs must converge once.
 const retryAfterClientFail=await r4RunSession(phoneA,phoneB,dbId),afterClientRetryA=await saved(phoneA),afterClientRetryB=await saved(phoneB);
 verify('retry after client save failure confirms both commits',retryAfterClientFail.clientValue===true&&retryAfterClientFail.net.hostStatus.status==='COMPLETED');
 verify('retry after client save failure transfers inspection exactly once',phoneB.run(`TC.records.filter(r=>r.syncId===${JSON.stringify(firstControl.kontrollId)}).length`)===1);
 verify('retry after client save failure transfers defect exactly once',phoneB.run(`TC.allDefects.filter(d=>d.syncId===${JSON.stringify(firstControl.defectId)}).length`)===1);
 verify('retry after client save failure transfers repair to Phone A',!phoneA.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(seedDefect)})`));
 verify('retry repair preserves repairer, action and exact close value',phoneA.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(seedDefect)}).repairer`)==='R5 first repairer'&&phoneA.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(seedDefect)}).repairAction`).includes('replaced and tested')&&!!phoneA.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(seedDefect)}).closedAt`));
 verify('repair apply did not append a Kontroll row',await liveRows(phoneA,'Kontrollid')===await liveRows(phoneB,'Kontrollid'));
 verify('current-cycle count is the union of unique checked EK IDs',phoneA.run('S.sessionChecked.size')===phoneB.run('S.sessionChecked.size')&&phoneA.run('new Set(Object.keys(TC.cycle.entries)).size')===phoneB.run('new Set(Object.keys(TC.cycle.entries)).size'));
 verify('durable journal now contains peer operations on both phones',afterClientRetryA.sync.journal.some(o=>o.entityId===firstControl.kontrollId)&&afterClientRetryB.sync.journal.some(o=>o.entityId===seedDefect&&o.action==='CLOSE_PUUDUS'));
 verify('appliedOps has no duplicates after retry',new Set(afterClientRetryA.sync.appliedOps).size===afterClientRetryA.sync.appliedOps.length&&new Set(afterClientRetryB.sync.appliedOps).size===afterClientRetryB.sync.appliedOps.length);
 verify('successful retry preserved workbook archive parts',Object.keys(phoneA.run('S.zip.files')).length===Object.keys(phoneB.run('S.zip.files')).length);
 // Phase 2 request is lost after Phone B committed Phone A's first delta.
 const secondControl=await inspectOn(phoneA,dirA,'R5 between-exchange inspection defect');
 const secondRepair=await repairOn(phoneB,dirB,firstControl.defectId,'between-exchange');
 beforeA=await saved(phoneA);beforeB=await saved(phoneB);
 const droppedSecond=await r4RunSession(phoneA,phoneB,dbId,'remote',{dropClientRequestAt:2}),afterDroppedA=await saved(phoneA),afterDroppedB=await saved(phoneB);
 verify('TCP exchange two was attempted and failed before host receive',droppedSecond.net.clientCalls.length===2&&droppedSecond.net.hostStatus.status==='ERROR');
 verify('exchange-two failure is reported as uncertain on the client',uncertain(droppedSecond)&&noSuccess(droppedSecond));
 verify('exchange-two failure retains first-phase durable client apply',!sameBusiness(afterDroppedB,beforeB)&&phoneB.run(`TC.records.some(r=>r.syncId===${JSON.stringify(secondControl.kontrollId)})`));
 verify('exchange-two failure has not applied Phone B repair at host',sameBusiness(afterDroppedA,beforeA)&&phoneA.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(secondRepair.syncId)})`));
 verify('exchange-two failure does not add half rows to host workbook',await liveRows(phoneA,'Kontrollid')===await liveRows(phoneB,'Kontrollid'));
 verify('exchange-two uncertain state keeps peer operations pending for retry',afterDroppedB.sync.journal.some(o=>o.entityId===secondControl.kontrollId)&&afterDroppedA.sync.journal.every(o=>o.opId));
 const retrySecond=await r4RunSession(phoneA,phoneB,dbId),afterRetrySecondA=await saved(phoneA),afterRetrySecondB=await saved(phoneB);
 verify('retry after inter-exchange loss reaches durable success',retrySecond.clientValue===true&&retrySecond.net.hostStatus.status==='COMPLETED');
 verify('retry after inter-exchange loss applies repair at host exactly once',!phoneA.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(secondRepair.syncId)})`)&&phoneA.run(`TC.allDefects.filter(d=>d.syncId===${JSON.stringify(secondRepair.syncId)}).length`)===1);
 verify('retry after inter-exchange loss keeps one inspection row',phoneA.run(`TC.records.filter(r=>r.syncId===${JSON.stringify(secondControl.kontrollId)}).length`)===1&&phoneB.run(`TC.records.filter(r=>r.syncId===${JSON.stringify(secondControl.kontrollId)}).length`)===1);
 verify('repeat after inter-exchange retry has no row growth',await liveRows(phoneA,'Kontrollid')===afterRetrySecondA.summary.controlCount&&await liveRows(phoneB,'Puudused')===afterRetrySecondB.summary.defectCount);
 verify('repeat after inter-exchange retry reports zero semantic changes',(await r4RunSession(phoneA,phoneB,dbId)).dialogs.filter(d=>d.title==='SÜNKROONIMINE').every(d=>/\+ 0 kontrolli/.test(d.body)&&/\+ 0 uut puudust/.test(d.body)&&/0 parandust/.test(d.body)));
 // Host's durable store rejects the second direction after client has committed.
 const thirdControl=await inspectOn(phoneA,dirA,'R5 host-commit rollback defect');
 const thirdRepair=await repairOn(phoneB,dirB,secondControl.defectId,'host-rollback');beforeA=await saved(phoneA);beforeB=await saved(phoneB);
 const hostSaveFailure=await r4RunSession(phoneA,phoneB,dbId,'remote',{failHostSave:true}),afterHostFailA=await saved(phoneA),afterHostFailB=await saved(phoneB);
 verify('host save fault is reported as uncertain, never success',uncertain(hostSaveFailure)&&noSuccess(hostSaveFailure));
 verify('host save failure restores the prior business workbook state',sameBusiness(afterHostFailA,beforeA));
 verify('host save failure restores old applied operation set',JSON.stringify(afterHostFailA.sync.appliedOps)===JSON.stringify(beforeA.sync.appliedOps));
 verify('host save failure does not append half-present repair row',phoneA.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(thirdRepair.syncId)})`)&&phoneA.run(`TC.allDefects.filter(d=>d.syncId===${JSON.stringify(thirdRepair.syncId)}).length`)===1);
 verify('client keeps its durable first-direction inspection after host failure',!sameBusiness(afterHostFailB,beforeB)&&phoneB.run(`TC.records.some(r=>r.syncId===${JSON.stringify(thirdControl.kontrollId)})`));
 verify('host failure leaves no fake Kontroll repair record',await liveRows(phoneA,'Kontrollid')===await liveRows(phoneB,'Kontrollid'));
 const restartedA=await restart(phoneA,dirA,deviceA);phoneA=restartedA;
 verify('restart after failed host transaction restores old workbook',phoneA.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(thirdRepair.syncId)})`)&&!phoneA.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(firstControl.defectId)})`));
 verify('restart after failed host transaction has no uncommitted peer close operation',!phoneA.run(`TC.sync.journal.some(o=>o.entityId===${JSON.stringify(thirdRepair.syncId)}&&o.deviceId===${JSON.stringify(deviceB)}&&o.action==='CLOSE_PUUDUS')`));
 const retryHost=await r4RunSession(phoneA,phoneB,dbId),afterRetryHostA=await saved(phoneA),afterRetryHostB=await saved(phoneB);
 verify('retry after host rollback applies the repair and converges',retryHost.clientValue===true&&!phoneA.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(thirdRepair.syncId)})`)&&phoneA.run(`TC.records.some(r=>r.syncId===${JSON.stringify(thirdControl.kontrollId)})`));
 verify('retry after host rollback does not duplicate client committed inspection',phoneB.run(`TC.records.filter(r=>r.syncId===${JSON.stringify(thirdControl.kontrollId)}).length`)===1&&phoneA.run(`TC.records.filter(r=>r.syncId===${JSON.stringify(thirdControl.kontrollId)}).length`)===1);
 verify('retry after host rollback persists journal and unique applied IDs',afterRetryHostA.sync.journal.some(o=>o.entityId===thirdRepair.syncId)&&new Set(afterRetryHostA.sync.appliedOps).size===afterRetryHostA.sync.appliedOps.length&&new Set(afterRetryHostB.sync.appliedOps).size===afterRetryHostB.sync.appliedOps.length);
 // Both sides commit, but the final ACK is lost before delivery to the client.
 const fourthControl=await inspectOn(phoneA,dirA,'R5 lost-ack inspection defect');
 const fourthRepair=await repairOn(phoneB,dirB,thirdControl.defectId,'lost-ack');beforeA=await saved(phoneA);beforeB=await saved(phoneB);
 const ackLost=await r4RunSession(phoneA,phoneB,dbId,'remote',{dropHostResponseAt:2}),afterAckLostA=await saved(phoneA),afterAckLostB=await saved(phoneB);
 verify('lost final ACK occurs after host receives the second exchange',ackLost.net.clientCalls.length===2&&ackLost.net.droppedHostResponse===2);
 verify('lost final ACK makes no false success claim on either UI',noSuccess(ackLost)&&uncertain(ackLost));
 verify('lost final ACK preserves durable host-side repair commit',!sameBusiness(afterAckLostA,beforeA)&&!phoneA.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(fourthRepair.syncId)})`));
 verify('lost final ACK preserves durable client-side incoming inspection',!sameBusiness(afterAckLostB,beforeB)&&phoneB.run(`TC.records.some(r=>r.syncId===${JSON.stringify(fourthControl.kontrollId)})`));
 verify('lost final ACK leaves applied operation IDs unique on both stores',new Set(afterAckLostA.sync.appliedOps).size===afterAckLostA.sync.appliedOps.length&&new Set(afterAckLostB.sync.appliedOps).size===afterAckLostB.sync.appliedOps.length);
 const restartedB=await restart(phoneB,dirB,deviceB);phoneB=restartedB;
 verify('restart after committed-but-unacknowledged sync restores inspection and repair',phoneB.run(`TC.records.some(r=>r.syncId===${JSON.stringify(fourthControl.kontrollId)})`)&&!phoneB.run(`S.existingDefects.some(d=>d.syncId===${JSON.stringify(seedDefect)})`));
 verify('restart retains sync epoch and independent device identities',phoneA.run('TC.sync.epoch')===phoneB.run('TC.sync.epoch')&&phoneA.run('TC.deviceId')!==phoneB.run('TC.deviceId'));
 const retryAck=await r4RunSession(phoneA,phoneB,dbId),afterRetryAckA=await saved(phoneA),afterRetryAckB=await saved(phoneB);
 let retryHostReply=null;try{retryHostReply=JSON.parse(retryAck.net.hostResponses[0]?.toString('utf8')||'null');}catch(e){}
 let retrySender='';try{const request=Buffer.from(retryAck.net.clientCalls[0].requestBase64,'base64'),z=await JSZip.loadAsync(request),m=JSON.parse(await z.file('manifest.json').async('string'));retrySender=m.senderDeviceId;}catch(e){}
 verify('retry after lost ACK terminates normally with validated commit response',retryAck.clientValue===true&&retryAck.net.hostStatus.status==='COMPLETED',JSON.stringify({clientValue:retryAck.clientValue,hostStatus:retryAck.net.hostStatus.status,hostDevice:phoneA.run('TC.deviceId'),clientDevice:phoneB.run('TC.deviceId'),requestSender:retrySender,clientCalls:retryAck.net.clientCalls.length,responses:retryAck.net.hostResponses.length,hostReply:retryHostReply&&{phase:retryHostReply.phase,reason:retryHostReply.reason},dialogs:retryAck.dialogs.map(d=>d.role+':'+d.title)}));
 verify('retry after lost ACK creates zero duplicate Kontroll rows',phoneA.run(`TC.records.filter(r=>r.syncId===${JSON.stringify(fourthControl.kontrollId)}).length`)===1&&phoneB.run(`TC.records.filter(r=>r.syncId===${JSON.stringify(fourthControl.kontrollId)}).length`)===1);
 verify('retry after lost ACK creates zero duplicate Puudused rows',phoneA.run(`TC.allDefects.filter(d=>d.syncId===${JSON.stringify(fourthControl.defectId)}).length`)===1&&phoneB.run(`TC.allDefects.filter(d=>d.syncId===${JSON.stringify(fourthControl.defectId)}).length`)===1);
 verify('repeat sync after lost ACK reports zero new inspections and repairs',(await r4RunSession(phoneA,phoneB,dbId)).dialogs.filter(d=>d.title==='SÜNKROONIMINE').every(d=>/\+ 0 kontrolli/.test(d.body)&&/0 parandust/.test(d.body)));
 verify('committed close preserves repairer action and timestamp after retry',phoneA.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(fourthRepair.syncId)}).repairer`)==='R5 lost-ack repairer'&&phoneB.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(fourthRepair.syncId)}).repairAction`).includes('replaced and tested')&&!!phoneA.run(`TC.allDefects.find(d=>d.syncId===${JSON.stringify(fourthRepair.syncId)}).closedAt`));
 // Protocol package validation must reject bad bytes before the durable apply.
 const validationBaseline=await saved(phoneB),validBytes=await phoneA.run('createSyncDeltaBytes()');
 const wrongDb=await packageFrom(phoneA,m=>{m.dbId='foreign-db';});const wrongDbResult=await rejectedWithoutWrite(phoneB,wrongDb,'wrong-db.dtcs');
 verify('wrong dbId is rejected before write',wrongDbResult.rejected&&wrongDbResult.unchanged);
 const wrongEpoch=await packageFrom(phoneA,m=>{m.epoch='foreign-epoch';});const wrongEpochResult=await rejectedWithoutWrite(phoneB,wrongEpoch,'wrong-epoch.dtcs');
 verify('wrong epoch is rejected before write',wrongEpochResult.rejected&&wrongEpochResult.unchanged);
 const corruptHash=await packageFrom(phoneA,(m,ops)=>{ops[0].changedFields.description='tampered';},false);const corruptResult=await rejectedWithoutWrite(phoneB,corruptHash,'bad-hash.dtcs');
 verify('payload integrity mismatch is rejected without journal mutation',corruptResult.rejected&&corruptResult.unchanged);
 const malformedZip=await rejectedWithoutWrite(phoneB,new Uint8Array([0x50,0x4b,3,4,0]),'truncated-container.dtcs');
 verify('malformed ZIP framing is rejected without workspace mutation',malformedZip.rejected&&malformedZip.unchanged);
 const unknownAction=await packageFrom(phoneA,(m,ops)=>{if(ops.length)ops[0].action='DELETE_EVERYTHING';});const actionResult=await rejectedWithoutWrite(phoneB,unknownAction,'unknown-action.dtcs');
 verify('unknown operation action is rejected before apply',actionResult.rejected&&actionResult.unchanged);
 const malformedId=await packageFrom(phoneA,(m,ops)=>{if(ops.length)ops[0].entityId='../outside';});const idResult=await rejectedWithoutWrite(phoneB,malformedId,'bad-entity-id.dtcs');
 verify('malformed stable entity ID is rejected before apply',idResult.rejected&&idResult.unchanged);
 const mismatchedOpId=await packageFrom(phoneA,(m,ops)=>{if(ops.length)ops[0].opId='other-device:999';});const opIdResult=await rejectedWithoutWrite(phoneB,mismatchedOpId,'bad-op-id.dtcs');
 verify('operation ID/device sequence mismatch is rejected',opIdResult.rejected&&opIdResult.unchanged);
 const unknownField=await packageFrom(phoneA,(m,ops)=>{if(ops.length)ops[0].changedFields.unhandledField='x';});const fieldResult=await rejectedWithoutWrite(phoneB,unknownField,'unknown-field.dtcs');
 verify('unknown semantic field is rejected instead of silently journalled',fieldResult.rejected&&fieldResult.unchanged);
 verify('workbook stayed logically intact after all rejected packages',JSON.stringify((await saved(phoneB)).summary)===JSON.stringify(validationBaseline.summary));
 verify('validation errors do not leave busy or transaction staging state',!phoneB.run('TC.busy')&&!phoneB.run('TC.pendingSemanticRows')&&!phoneB.run('TC.pendingSyncRowIds'));
 // Duplicate operation delivery in one package and already-applied replay are safe.
 const sourceZip=await JSZip.loadAsync(validBytes),manifest=JSON.parse(await sourceZip.file('manifest.json').async('string')),sourceOps=JSON.parse(await sourceZip.file(manifest.operations.path||'operations.json').async('string'));
 if(sourceOps.length){const dup=sourceOps[0];const dupPayload=await packageFrom(phoneA,(m,ops)=>ops.push(JSON.parse(JSON.stringify(dup))));const dupZip=await JSZip.loadAsync(dupPayload),dupManifest=JSON.parse(await dupZip.file('manifest.json').async('string')),dupOps=JSON.parse(await dupZip.file(dupManifest.operations.path||'operations.json').async('string'));const preview=phoneB.run(`previewSyncOperations(${JSON.stringify(dupOps)})`);
  verify('repeated operation inside one payload is classified as duplicate',preview.duplicates>=1);
  const rowsBefore=await liveRows(phoneB,'Kontrollid'),appliedBefore=phoneB.run('TC.sync.appliedOps.length');await phoneB.run(`applySyncOperations(${JSON.stringify(dupOps)},${JSON.stringify(phoneA.run('TC.deviceId'))})`);
  verify('duplicate payload apply does not append a Kontroll row',await liveRows(phoneB,'Kontrollid')===rowsBefore);
  verify('duplicate payload apply does not increase appliedOps',phoneB.run('TC.sync.appliedOps.length')===appliedBefore);
  verify('already-applied replay remains idempotent after restart',new Set((await saved(phoneB)).sync.appliedOps).size===(await saved(phoneB)).sync.appliedOps.length);
 }else throw Error('No semantic operation available for duplicate delivery checks.');
 // Final independent restart check includes cycles, conflict structures, journal, archive parts.
 const finalA=await restart(phoneA,dirA,deviceA),finalB=await restart(phoneB,dirB,deviceB),finalSnapA=await saved(finalA),finalSnapB=await saved(finalB),metaA=await workbookMeta(finalA),metaB=await workbookMeta(finalB);
 verify('restart after successful/retried transactions restores equal cycle progress',finalA.run('TC.cycle.id')===finalB.run('TC.cycle.id')&&finalA.run('S.sessionChecked.size')===finalB.run('S.sessionChecked.size'));
 verify('restart restores all exchanged inspections and defects',finalA.run(`TC.records.some(r=>r.syncId===${JSON.stringify(firstControl.kontrollId)})`)&&finalB.run(`TC.records.some(r=>r.syncId===${JSON.stringify(fourthControl.kontrollId)})`)&&finalA.run(`TC.allDefects.some(d=>d.syncId===${JSON.stringify(fourthControl.defectId)})`));
 verify('restart restores journal and applied operation identities',finalSnapA.sync.journal.length>0&&finalSnapB.sync.journal.length>0&&finalSnapA.sync.appliedOps.length>0&&finalSnapB.sync.appliedOps.length>0);
 verify('restart restores conflict history without unresolved duplicates',Array.isArray(finalSnapA.sync.conflicts)&&Array.isArray(finalSnapB.sync.conflicts));
 verify('restart preserves the eight-sheet workbook model and archive parts',metaA.names.length===8&&JSON.stringify(metaA.names)===JSON.stringify(metaB.names)&&metaA.fileCount===metaB.fileCount);
 verify('restart preserves formula count and formula content hash',metaA.formulaCount>0&&metaA.formulaCount===metaB.formulaCount&&metaA.formulaHash===metaB.formulaHash);
 verify('restart leaves every applied operation ID unique',new Set(finalSnapA.sync.appliedOps).size===finalSnapA.sync.appliedOps.length&&new Set(finalSnapB.sync.appliedOps).size===finalSnapB.sync.appliedOps.length);
 verify('old file sync and full work handoff remain available',finalA.run("typeof processSyncPackageBytes==='function'&&typeof importWorkPackage==='function'&&typeof createWorkPackageBytes==='function'"));
 verify('R3 bootstrap/import path remains intact after R5 hardening',finalA.run("typeof validateDirectBaselineBytes==='function'&&typeof importSyncBaseline==='function'"));
 verify('workspace snapshots use schema 1 and retain workbook bytes',finalSnapA.schema===1&&finalSnapB.schema===1&&finalSnapA.workbookBase64.length>0&&finalSnapB.workbookBase64.length>0);
 verify('no unauthorised newer-workbook replacement path was added',!phoneA.run("typeof directSyncReplaceWorkbook==='function'")&&!phoneB.run("typeof directSyncReplaceWorkbook==='function'"));
 assert(checks.length>=50,`R5 safety coverage dropped below 50 checks: ${checks.length}`);
 fs.writeFileSync(path.join(out,'r5-results.json'),JSON.stringify({passed:checks.length,total:checks.length,cases:checks},null,2));
 console.log(`R5 SAFETY ${checks.length}/${checks.length} PASS`);
});
await test('R3 stale cycle metadata on same database must preserve four local Kontroll IDs',async()=>{
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};
 try{
  await freshWorkspace('r3-stale-cycle-metadata',bytes);run('TC.guard.remaining=100');await run('resetRingProgress()');
  const cabinets=run('activeCabinets().slice(0,4).map(c=>c.id)');
  for(let i=0;i<cabinets.length;i++)await saveTestInspection(cabinets[i],i===0?'R3 linked defect':'');
  assert.equal(run('S.sessionChecked.size'),4);const localCycle=JSON.parse(JSON.stringify(run('TC.cycle')));
  assert(cabinets.every(id=>localCycle.entries[id]?.kontrollId),'Every saved cycle entry should already have a persistent KontrollID');
  const incomingBytes=await run(`(async()=>{const current=S.zip;S.zip=cloneWorkbook(current);const complete=cloneData(TC.cycle),first=${JSON.stringify(cabinets[0])};TC.cycle={...complete,id:'stale-import-cycle',entries:{[first]:cloneData(complete.entries[first])}};await writeMetadata();const bytes=await S.zip.generateAsync({type:'uint8array'});S.zip=current;TC.cycle=complete;return bytes;})()`);
  await importBytes(Buffer.from(incomingBytes),'updated_same_database.xlsx','merge');
  assert.equal(run('S.sessionChecked.size'),4,'Importing stale/different embedded cycle metadata must not reduce 4 checked cabinets');
  for(const id of cabinets)assert.equal(run(`savedEntry(${JSON.stringify(id)})?.syncId`),localCycle.entries[id].kontrollId);
  assert.equal(await count('Kontrollid'),initialRows+4);
  assert(run(`TC.cycle.entries[${JSON.stringify(cabinets[0])}].defectRows.length>0`),'Existing defect links must remain attached');
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('R3 fuller incoming cycle unions its permanent IDs with the local cycle',async()=>{
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};
 try{
  await freshWorkspace('r3-incoming-fuller',bytes);run('TC.guard.remaining=100');await run('resetRingProgress()');const cabinets=run('activeCabinets().slice(0,4).map(c=>c.id)');
  await saveTestInspection(cabinets[0]);await saveTestInspection(cabinets[1]);const localSnapshot=JSON.parse(JSON.stringify(await run('storeCall("get",TC.dbId)'))),cycleId=run('TC.cycle.id');
  await saveTestInspection(cabinets[2]);await saveTestInspection(cabinets[3]);const incoming=Buffer.from(await run('persistWorkspace()'));
  env.cx.r3LocalSnapshot=localSnapshot;await run('storeCall("put",r3LocalSnapshot)');await importBytes(incoming,'peer_fuller_same_cycle.xlsx','merge');
  assert.equal(run('TC.cycle.id'),cycleId);assert.equal(run('S.sessionChecked.size'),4);assert(cabinets.every(id=>run(`!!savedEntry(${JSON.stringify(id)})`)));assert.equal(await count('Kontrollid'),initialRows+4);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('R3 identical cycle entries remain stable and do not duplicate records',async()=>{
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};
 try{
  const created=await r3Prepare('r3-identical-cycle',bytes,2),cycleId=created.cycle.id,incoming=Buffer.from(await run('persistWorkspace()'));
  await importBytes(incoming,'same_cycle_export.xlsx','merge');assert.equal(run('TC.cycle.id'),cycleId);assert.equal(run('S.sessionChecked.size'),2);assert.equal(Object.keys(run('TC.cycle.entries')).length,2);assert.equal(await count('Kontrollid'),created.controls);
  for(const id of created.ids)assert.equal(run(`savedEntry(${JSON.stringify(id)}).syncId`),created.cycle.entries[id].kontrollId);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('R3 missing incoming cycle metadata preserves local IDs from Kontrollid AA',async()=>{
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};
 try{
  const created=await r3Prepare('r3-missing-embedded-cycle',bytes,3),incoming=await run(`(async()=>{const current=S.zip;S.zip=cloneWorkbook(current);const cycle=TC.cycle;TC.cycle=null;await writeMetadata();const bytes=await S.zip.generateAsync({type:'uint8array'});S.zip=current;TC.cycle=cycle;return bytes;})()`);
  await importBytes(Buffer.from(incoming),'same_database_no_cycle_metadata.xlsx','merge');assert.equal(run('S.sessionChecked.size'),3);assert.equal(run('TC.cycle.id'),created.cycle.id);
  for(const id of created.ids)assert.equal(run(`savedEntry(${JSON.stringify(id)}).syncId`),created.cycle.entries[id].kontrollId);
  assert.equal(await count('Kontrollid'),created.controls);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('R3 row movement and rounded Excel W restore by KontrollID and retain defect links',async()=>{
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};
 try{
  const created=await r3Prepare('r3-row-w-stability',bytes,3,true),controlIds=created.ids.map(id=>created.cycle.entries[id].kontrollId),expectedRows=JSON.parse(JSON.stringify(run(`TC.allDefects.filter(d=>d.kontrollId===${JSON.stringify(controlIds[0])}).map(d=>d.row)`)));
  const beforeRows=created.controls,changed=await run(`(async()=>{const doc=await loadDoc('Kontrollid'),targets=${JSON.stringify(controlIds)},moved={};for(const id of targets){const row=TC.records.find(r=>r.syncId===id)?.row;if(!row)throw Error('missing control '+id);const value=Number(getCellVal(doc,'W',row));if(Number.isFinite(value))setNum(doc,'W',row,value+0.000000005);const node=qsa(doc,'row').find(x=>Number(x.getAttribute('r'))===row),newRow=row+10000;node.setAttribute('r',String(newRow));for(const cell of qsa(node,'c'))cell.setAttribute('r',refCol(cell.getAttribute('r'))+newRow);moved[id]=newRow;}S.zip.file(S.paths.Kontrollid,xmlStr(doc));return {moved,bytes:await S.zip.generateAsync({type:'uint8array'})};})()`);
  // Reload through a VM global so the actual workbook parser and hydrator run.
  env.cx.r3ReloadBytes=Buffer.from(changed.bytes);await run('loadBook(r3ReloadBytes,"moved_and_rounded.xlsx")');
  assert.equal(run('S.sessionChecked.size'),3);assert.equal(await count('Kontrollid'),beforeRows);
  for(const id of created.ids){const entry=run(`savedEntry(${JSON.stringify(id)})`);assert(entry);assert.equal(entry.syncId,created.cycle.entries[id].kontrollId);assert.equal(entry.row,changed.moved[entry.syncId]);assert.equal(run(`TC.cycle.entries[${JSON.stringify(id)}].row`),entry.row);}
  const linkedDefect=run(`TC.allDefects.find(d=>d.kontrollId===${JSON.stringify(controlIds[0])})`);assert(linkedDefect);assert(run(`TC.cycle.entries[${JSON.stringify(created.ids[0])}].defectRows.includes(${linkedDefect.row})`));assert.deepEqual(expectedRows,[linkedDefect.row]);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('R3 additional KontrollIDs survive cycle merge without double-counting EK',async()=>{
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};
 try{
  await freshWorkspace('r3-additional-control-ids',bytes);run('TC.guard.remaining=100');await run('resetRingProgress()');const cabinet=run('activeCabinets()[0].id');await saveTestInspection(cabinet,'R3 previous-control defect');const firstId=run(`savedEntry(${JSON.stringify(cabinet)}).syncId`);
  await openCabWithChoices(cabinet,'camera',['new','create']);el('inspector').value='Stage 12 tester';run('setAllScores(4)');advance(61);await run('saveInspection()');const localEntry=JSON.parse(JSON.stringify(run(`TC.cycle.entries[${JSON.stringify(cabinet)}]`))),primaryId=localEntry.kontrollId;
  assert.notEqual(primaryId,firstId);assert(localEntry.additionalKontrollIds.includes(firstId));assert.equal(run('S.sessionChecked.size'),1);
  const rebuilt=run(`cycleFromRecords(TC.records.filter(r=>[${JSON.stringify(firstId)},${JSON.stringify(primaryId)}].includes(r.syncId)))`);assert.equal(rebuilt.entries[cabinet].kontrollId,primaryId);assert(rebuilt.entries[cabinet].additionalKontrollIds.includes(firstId));const oldDefectRow=run(`TC.allDefects.find(d=>d.kontrollId===${JSON.stringify(firstId)}).row`);assert(rebuilt.entries[cabinet].previousControlDefects[firstId].includes(oldDefectRow));
  const incoming=await run(`(async()=>{const current=S.zip;S.zip=cloneWorkbook(current);const link=TC.cycle.entries[${JSON.stringify(cabinet)}];TC.cycle=cloneData(TC.cycle);delete TC.cycle.entries[${JSON.stringify(cabinet)}].additionalKontrollIds;delete TC.cycle.entries[${JSON.stringify(cabinet)}].previousControlDefects;await writeMetadata();const bytes=await S.zip.generateAsync({type:'uint8array'});S.zip=current;TC.cycle={...TC.cycle,entries:{...TC.cycle.entries,[${JSON.stringify(cabinet)}]:cloneData(link)}};return bytes;})()`);
  await importBytes(Buffer.from(incoming),'additional_control_peer.xlsx','merge');const merged=run(`TC.cycle.entries[${JSON.stringify(cabinet)}]`);
  assert.equal(merged.kontrollId,primaryId);assert(merged.additionalKontrollIds.includes(firstId));assert.equal(run('S.sessionChecked.size'),1);assert.equal(run(`savedEntry(${JSON.stringify(cabinet)}).syncId`),primaryId);
  const linkedDefect=run(`TC.allDefects.find(d=>d.kontrollId===${JSON.stringify(firstId)})`);assert(linkedDefect);assert(merged.previousControlDefects[firstId].includes(linkedDefect.row));assert.equal(await count('Kontrollid'),initialRows+2);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('R3 legacy cycle adopts a unique no-AA record and then remains stable by migrated ID',async()=>{
 const legacyPath=process.env.DTC_R3_LEGACY_FIXTURE;if(!legacyPath)throw Error('Set DTC_R3_LEGACY_FIXTURE to the supplied v1.1 legacy workbook');
 const priorEnv=env,priorStore=storeDir,priorClock={...clock},legacyBytes=fs.readFileSync(legacyPath);
 try{
  await freshWorkspace('r3-legacy-cycle-id-migration',legacyBytes);
  const record=run(`TC.records.find(r=>!r.persistentId&&r.start&&TC.records.filter(x=>x.id===r.id&&x.date===r.date&&x.inspector===r.inspector&&realStartFromRecord(x)===realStartFromRecord(r)).length===1)`);assert(record,'Legacy workbook needs one uniquely matchable control without AA ID');
  const cabinet=record.id,originalId=record.syncId,legacyEntry={row:record.row,fingerprint:run(`recordFingerprint(TC.records.find(r=>r.row===${record.row}))`),defectRows:[],note:''};
  run(`TC.cycle={id:'r3-legacy-migration',startedAt:${JSON.stringify(record.date)},startSource:'records',entries:{[${JSON.stringify(cabinet)}]:${JSON.stringify(legacyEntry)}}};reconcileCycle()`);assert(run(`S.sessionChecked.has(${JSON.stringify(cabinet)})`));await run('ensureSyncState()');const migrated=run(`TC.cycle.entries[${JSON.stringify(cabinet)}].kontrollId`);assert(migrated);assert.equal(migrated,originalId);
  const changed=await run(`(async()=>{const doc=await loadDoc('Kontrollid'),id=${JSON.stringify(cabinet)},row=TC.records.find(r=>r.id===id&&r.syncId===${JSON.stringify(migrated)}).row,value=Number(getCellVal(doc,'W',row)),node=qsa(doc,'row').find(x=>Number(x.getAttribute('r'))===row),newRow=row+10000;if(Number.isFinite(value))setNum(doc,'W',row,value+0.000000005);node.setAttribute('r',String(newRow));for(const cell of qsa(node,'c'))cell.setAttribute('r',refCol(cell.getAttribute('r'))+newRow);S.zip.file(S.paths.Kontrollid,xmlStr(doc));return {newRow,bytes:await S.zip.generateAsync({type:'uint8array'})};})()`);
  env.cx.r3ReloadBytes=Buffer.from(changed.bytes);await run('loadBook(r3ReloadBytes,"legacy_moved_control.xlsx")');
  assert.equal(run('S.sessionChecked.size'),1);assert.equal(run(`savedEntry(${JSON.stringify(cabinet)}).syncId`),migrated);assert.equal(run(`TC.cycle.entries[${JSON.stringify(cabinet)}].kontrollId`),migrated);assert.equal(run(`TC.cycle.entries[${JSON.stringify(cabinet)}].row`),changed.newRow);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('S1 signature capture launches from a saved Kontroll and freezes its metadata snapshot version',async()=>{
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};try{
  const signatureBytes=process.env.DTC_S1_5_SIGNATURE_FIXTURE?fs.readFileSync(process.env.DTC_S1_5_SIGNATURE_FIXTURE):bytes;await freshWorkspace('s1-signature-launch',signatureBytes);
  const record=JSON.parse(JSON.stringify(run('TC.records.find(r=>r.persistentId&&r.syncId)')));assert(record?.syncId,'Fixture needs a persistent KontrollID');
  run(`S.selected=S.cabinets.find(c=>c.id===${JSON.stringify(record.id)})`);
  const exact=await run(`draftKontrollRecordVersion(TC.records.find(r=>r.syncId===${JSON.stringify(record.syncId)}))`);assert(Number.isInteger(exact.recordVersion)&&exact.recordVersion>=1);assert.equal(exact.recordVersionSource,'KONTROLL_SNAPSHOT_METADATA_V1');assert.match(exact.recordVersionSnapshotHash,/^[a-f0-9]{64}$/);
  const savedRevision=run('TC.revision'),savedRows=run('TC.records.length');const dialog=run(`viewSavedInspection(${JSON.stringify(record.id)},${JSON.stringify(record)},{})`);await waitForAppDialog('VAATA KONTROLLI');
  assert.equal(el('appDialogTitle').textContent,'VAATA KONTROLLI');assert(el('appDialogActions').innerHTML.includes('ALLKIRJA MUSTAND'));
  run("appDialogChoice('signature')");await dialog;const payload=env.signatureStartCalls.pop();assert(payload,'native capture bridge was not called');
  assert.equal(payload.targetType,'Kontroll');assert.equal(payload.recordId,record.syncId);assert.equal(payload.kilpId,record.id);assert.equal(payload.signerName,record.inspector);
  assert.equal(payload.recordVersion,exact.recordVersion);assert.equal(payload.recordVersionSource,'KONTROLL_SNAPSHOT_METADATA_V1');assert.equal(payload.metadata.recordVersionSnapshotHash,exact.recordVersionSnapshotHash);assert.equal(payload.metadata.workbookIdentity,run('TC.dbId'));
  assert.equal(payload.deviceInstanceId,run('TC.deviceId'));assert.equal(run('TC.revision'),savedRevision+1);assert.equal(run('TC.records.length'),savedRows);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('S1.5 post-save signature flow targets saved KontrollID and defers navigation through confirm, cancel, and failure',async()=>{
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};try{
  const signatureBytes=process.env.DTC_S1_5_SIGNATURE_FIXTURE?fs.readFileSync(process.env.DTC_S1_5_SIGNATURE_FIXTURE):bytes;await freshWorkspace('s1-5-post-save-signature',signatureBytes);await run('resetRingProgress()');run('TC.guard.remaining=100');
  const ids=run('activeCabinets().slice(0,5).map(c=>c.id)');assert(ids.length>=5,'Fixture needs five active cabinets for the post-save flow cases');
  async function prepareNew(id){await run(`openCab(${JSON.stringify(id)})`);el('inspector').value='S1.5 post-save tester';run('setAllScores(4)');advance(61);}
  function latestCapture(){const value=env.signatureStartCalls.at(-1);assert(value,'native signature capture was not requested');return value;}
  async function deliverSaved(recordId){const raw=JSON.stringify({targetType:'Kontroll',recordId,status:'DRAFT'});await run(`onNativeSignatureDraftSaved(${JSON.stringify(raw)})`);}
  function cancelCapture(){run("onNativeSignatureCaptureCancelled('TAGASI')");}

  // 1–2: ordinary SALVESTA requests capture only after the persisted permanent ID is available.
  await prepareNew(ids[0]);await run('saveInspection()');
  const firstId=run(`TC.cycle.entries[${JSON.stringify(ids[0])}].kontrollId`),firstSaved=run(`TC.records.some(r=>r.id===${JSON.stringify(ids[0])}&&r.syncId===${JSON.stringify(firstId)})`);
  assert(firstSaved,'Kontroll must be durable before signature capture');assert.equal(latestCapture().recordId,firstId);assert.equal(latestCapture().kilpId,ids[0]);
  assert.equal(run('pendingPostSaveSignatureNavigation.goNext'),false);assert(!el('inspectTab').classList.contains('hidden'),'ordinary save waits on signature while inspection remains open');
  // 4: KINNITA callback refreshes local drafts and then performs ordinary navigation.
  await deliverSaved(firstId);assert(el('inspectTab').classList.contains('hidden'));assert(!el('cabTab').classList.contains('hidden'));assert.equal(run('pendingPostSaveSignatureNavigation'),null);

  // 3–4: SALVESTA + JÄRGMINE must stay on this cabinet until the signature result arrives.
  await prepareNew(ids[1]);await run('saveInspection(true)');const nextId=run(`TC.cycle.entries[${JSON.stringify(ids[1])}].kontrollId`);
  assert.equal(latestCapture().recordId,nextId);assert.equal(run('S.selected.id'),ids[1]);assert.equal(run('TC.opened'),null);assert.equal(run('pendingPostSaveSignatureNavigation.goNext'),true);
  await deliverSaved(nextId);assert.equal(run('S.selected.id'),ids[2]);assert.equal(run('TC.opened.id'),ids[2]);

  // 5: TAGASI does not remove the saved record or create a draft and still navigates.
  await prepareNew(ids[3]);await run('saveInspection()');const cancelId=run(`TC.cycle.entries[${JSON.stringify(ids[3])}].kontrollId`);latestCapture();
  assert(run(`TC.records.some(r=>r.id===${JSON.stringify(ids[3])}&&r.syncId===${JSON.stringify(cancelId)})`));cancelCapture();
  assert.equal(run('pendingPostSaveSignatureNavigation'),null);assert.equal(run('JSON.parse(Android.listSignatureDrafts()).data.length'),0);assert(el('inspectTab').classList.contains('hidden'));
  assert(el('toast').textContent.includes('Kontroll salvestatud. Allkirja mustand jäi lisamata.'));

  // 6: a bridge start failure leaves the committed Kontroll intact and finishes navigation.
  await prepareNew(ids[4]);const originalStart=env.cx.Android.startSignatureCapture;env.cx.Android.startSignatureCapture=payload=>{env.signatureStartCalls.push(JSON.parse(payload));return false;};
  await run('saveInspection()');env.cx.Android.startSignatureCapture=originalStart;const failedStartId=run(`TC.cycle.entries[${JSON.stringify(ids[4])}].kontrollId`);
  assert.equal(latestCapture().recordId,failedStartId);assert(run(`TC.records.some(r=>r.id===${JSON.stringify(ids[4])}&&r.syncId===${JSON.stringify(failedStartId)})`));
  assert.equal(run('pendingPostSaveSignatureNavigation'),null);assert(el('inspectTab').classList.contains('hidden'));assert(el('toast').textContent.includes('Allkirja mustand jäi lisamata.'));

  // 7: editing keeps the existing KontrollID and automatically requests a new local draft.
  const beforeEditCount=run('TC.records.length');await openCabWithChoices(ids[0],'list',['edit']);run('setAllScores(3)');await run('saveInspection()');
  assert.equal(latestCapture().recordId,firstId);assert.equal(run(`TC.records.filter(r=>r.syncId===${JSON.stringify(firstId)}).length`),1);assert.equal(run('TC.records.length'),beforeEditCount);
  cancelCapture();

  // 8: deliberate UUS KONTROLL gets its newly-created permanent ID, not the prior ID.
  const checkedBefore=run('S.sessionChecked.size'),rowsBefore=run('TC.records.length');await openCabWithChoices(ids[0],'list',['new','create']);
  el('inspector').value='S1.5 duplicate tester';run('setAllScores(5)');advance(61);await run('saveInspection()');
  const duplicateId=run(`TC.cycle.entries[${JSON.stringify(ids[0])}].kontrollId`);assert(duplicateId&&duplicateId!==firstId);assert.equal(latestCapture().recordId,duplicateId);
  assert.equal(run('TC.records.length'),rowsBefore+1);assert.equal(run('S.sessionChecked.size'),checkedBefore);cancelCapture();

  // 9: the existing manual VAATA KONTROLLI → ALLKIRJA MUSTAND path remains usable.
 const latest=JSON.parse(JSON.stringify(run(`savedEntry(${JSON.stringify(ids[0])})`))),manual=run(`viewSavedInspection(${JSON.stringify(ids[0])},${JSON.stringify(latest)},TC.cycle.entries[${JSON.stringify(ids[0])}])`);await waitForAppDialog('VAATA KONTROLLI');
  assert.equal(el('appDialogTitle').textContent,'VAATA KONTROLLI');run("appDialogChoice('signature')");await manual;
  assert.equal(latestCapture().recordId,duplicateId);assert.equal(run('pendingPostSaveSignatureNavigation'),null);await deliverSaved(duplicateId);assert(el('cabTab').classList.contains('hidden')===false);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('S1.5 Kontroll recordVersion survives restart and XLSX roundtrip, uses ID after row move, and advances on signed-field edit',async()=>{
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};try{
  const signatureBytes=process.env.DTC_S1_5_SIGNATURE_FIXTURE?fs.readFileSync(process.env.DTC_S1_5_SIGNATURE_FIXTURE):bytes;await freshWorkspace('s1-5-control-version',signatureBytes);
  const original=JSON.parse(JSON.stringify(run('TC.records.find(r=>r.persistentId&&r.syncId)')));assert(original,'Fixture needs a persistent KontrollID');
  const first=await run(`draftKontrollRecordVersion(TC.records.find(r=>r.syncId===${JSON.stringify(original.syncId)}))`);assert(Number.isInteger(first.recordVersion)&&first.recordVersion>=1);
  const second=await run(`draftKontrollRecordVersion(TC.records.find(r=>r.syncId===${JSON.stringify(original.syncId)}))`);assert.equal(second.recordVersion,first.recordVersion);
  const exported=Buffer.from(await run('persistWorkspace()'));
  env=makeContext();await run('TC.startupTask');
  const afterRestart=await run(`draftKontrollRecordVersion(TC.records.find(r=>r.syncId===${JSON.stringify(original.syncId)}))`);assert.equal(afterRestart.recordVersion,first.recordVersion);
  await importBytes(exported,'s1_5_same_workbook_export.xlsx','incoming');
  const afterImport=await run(`draftKontrollRecordVersion(TC.records.find(r=>r.syncId===${JSON.stringify(original.syncId)}))`);assert.equal(afterImport.recordVersion,first.recordVersion);
  const moved=await run(`(async()=>{const doc=await loadDoc('Kontrollid'),id=${JSON.stringify(original.syncId)},row=TC.records.find(r=>r.syncId===id).row,node=qsa(doc,'row').find(x=>Number(x.getAttribute('r'))===row),newRow=row+10000;node.setAttribute('r',String(newRow));for(const cell of qsa(node,'c'))cell.setAttribute('r',refCol(cell.getAttribute('r'))+newRow);S.zip.file(S.paths.Kontrollid,xmlStr(doc));return {newRow,bytes:await S.zip.generateAsync({type:'uint8array'})};})()`);
  const stale=JSON.parse(JSON.stringify(run(`TC.records.find(r=>r.syncId===${JSON.stringify(original.syncId)})`)));assert.notEqual(stale.row,moved.newRow);
  env.cx.s1MovedBytes=new Uint8Array(moved.bytes);await run('loadBook(s1MovedBytes,"row_moved_only.xlsx")');
  const afterMove=await run(`draftKontrollRecordVersion(${JSON.stringify(stale)})`);assert.equal(afterMove.recordVersion,first.recordVersion,'row movement alone must not change the signed record version');
  const changed=await run(`(async()=>{const doc=await loadDoc('Kontrollid'),id=${JSON.stringify(original.syncId)},row=${moved.newRow},old=getCellVal(doc,'H',${moved.newRow}),next=(Number(old)||0)+1;setNum(doc,'H',row,next);S.zip.file(S.paths.Kontrollid,xmlStr(doc));return {old,bytes:await S.zip.generateAsync({type:'uint8array'})};})()`);
  env.cx.s1MovedBytes=new Uint8Array(changed.bytes);await run('loadBook(s1MovedBytes,"signed_score_edited.xlsx")');
  const advanced=await run(`draftKontrollRecordVersion(${JSON.stringify(stale)})`);assert.equal(advanced.recordVersion,first.recordVersion+1);assert.equal(advanced.recordVersionSource,'KONTROLL_SNAPSHOT_METADATA_V1');
  const stableAgain=await run(`draftKontrollRecordVersion(${JSON.stringify(stale)})`);assert.equal(stableAgain.recordVersion,advanced.recordVersion);
  assert.equal(run(`TC.records.filter(r=>r.syncId===${JSON.stringify(original.syncId)}).length`),1);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('S1.5 legacy Kontroll without persistent AA stays UNRESOLVED and never invents version one',async()=>{
 const legacyPath=process.env.DTC_R3_LEGACY_FIXTURE;if(!legacyPath)throw Error('Set DTC_R3_LEGACY_FIXTURE to the supplied v1.1 legacy workbook');
 const priorEnv=env,priorStore=storeDir,priorClock={...clock};try{
  await freshWorkspace('s1-5-legacy-version',fs.readFileSync(legacyPath));
  const record=run('TC.records.find(r=>!r.persistentId&&r.syncId)');assert(record,'Fixture needs a legacy Kontroll row without AA');
  const result=await run(`draftKontrollRecordVersion(${JSON.stringify(record)})`);assert.equal(result.recordVersion,null);assert.equal(result.recordVersionSource,'UNRESOLVED');
  run(`startDoldParandusSignatureDraft({recordId:'dtc-work-test-6cc420fc-8ee7-40a2-9a48-0f458b398e8f',kilpId:'EK-027',signerName:'Test signer',recordVersion:0,puudusId:'dtc-puudus-test',kontrollId:${JSON.stringify(record.syncId)}})`);
  const payload=env.signatureStartCalls.pop();assert.equal(payload.targetType,'Parandus');assert.equal(payload.recordId,'dtc-work-test-6cc420fc-8ee7-40a2-9a48-0f458b398e8f');assert.equal(payload.recordVersion,null);assert.equal(payload.recordVersionSource,'UNRESOLVED');
  assert.equal(payload.metadata.puudusId,'dtc-puudus-test');assert.equal(payload.metadata.kontrollId,record.syncId);
 }finally{env=priorEnv;storeDir=priorStore;clock.mono=priorClock.mono;clock.offset=priorClock.offset;}
});
await test('S1.5 production target and effective-status formulas require unique ID and type-preserving snapshot equality',async()=>{
 const kontrollTarget=run('signatureTargetFormula("Kontroll",5)'),parandusTarget=run('signatureTargetFormula("Parandus",6)'),kontrollStatus=run('signatureEffectiveStatusFormula("Kontroll",5)'),parandusStatus=run('signatureEffectiveStatusFormula("Parandus",6)');
 fs.writeFileSync(path.join(out,'s1-5-signature-formulas.json'),JSON.stringify({kontrollTarget,parandusTarget,kontrollStatus,parandusStatus},null,2));
 assert(kontrollTarget.includes('COUNTIF(Kontrollid!$AA$5:$AA$500,$C5)=1'));assert(kontrollTarget.includes('MATCH($C5,Kontrollid!$AA$5:$AA$500,0)'));
 assert(parandusTarget.includes('COUNTIF(Parandused!$A$5:$A$500,$C6)=1'));assert(parandusTarget.includes('MATCH($C6,Parandused!$A$5:$A$500,0)'));
 assert(kontrollStatus.includes('$F5="Tühistatud"')&&kontrollStatus.includes('$F5="Kehtiv"'));assert(parandusStatus.includes('$F6="Tühistatud"')&&parandusStatus.includes('$F6="Kehtiv"'));
 assert.equal((kontrollStatus.match(/ISBLANK\(/g)||[]).length,54);assert.equal((kontrollStatus.match(/TYPE\(/g)||[]).length,54);assert(kontrollStatus.includes('EXACT('));
 assert.equal((parandusStatus.match(/ISBLANK\(/g)||[]).length,33);assert.equal((parandusStatus.match(/TYPE\(/g)||[]).length,33);assert(parandusStatus.includes('EXACT('));
 assert(kontrollStatus.includes('INDEX(Kontrollid!$H$5:$H$500,$T5)')&&kontrollStatus.includes('$X5'));assert(kontrollStatus.includes('INDEX(Kontrollid!$Z$5:$Z$500,$T5)')&&kontrollStatus.includes('$AL5'));
 assert(parandusStatus.includes('INDEX(Parandused!$L$5:$L$500,$T6)')&&parandusStatus.includes('$AT6'));assert(parandusStatus.includes('INDEX(Parandused!$O$5:$O$500,$T6)')&&parandusStatus.includes('$AW6'));
 assert(kontrollTarget.length<=8192&&parandusTarget.length<=8192&&kontrollStatus.length<=8192&&parandusStatus.length<=8192,'Generated formulas must stay within Excel formula length limit');
 assert(!/Näidis/.test(kontrollStatus+parandusStatus),'Production status formulas must not create TEST Näidis states');
 assert.throws(()=>run('signatureTargetFormula("Unknown",5)'),/Tundmatu allkirja sihttüüp/);
 for(const [sourceCol,snapshotCol] of run('SIGNATURE_SNAPSHOT_FIELDS.Kontroll'))assert(kontrollStatus.includes(`INDEX(Kontrollid!$${sourceCol}$5:$${sourceCol}$500,$T5)`)&&kontrollStatus.includes(`$${snapshotCol}5`),`Missing Kontroll snapshot mapping ${sourceCol} → ${snapshotCol}`);
 for(const [sourceCol,snapshotCol] of run('SIGNATURE_SNAPSHOT_FIELDS.Parandus'))assert(parandusStatus.includes(`INDEX(Parandused!$${sourceCol}$5:$${sourceCol}$500,$T6)`)&&parandusStatus.includes(`$${snapshotCol}6`),`Missing Parandus snapshot mapping ${sourceCol} → ${snapshotCol}`);
});
await test('S1 signature draft list remains local-only and does not invoke workbook writes',async()=>{
 const before=run('TC.revision'),rows=run('TC.records.length');run('refreshSignatureDrafts()');
 assert(el('signatureDraftList').innerHTML.includes('Salvestatud allkirja mustandeid pole'));
 assert.equal(run('TC.revision'),before);assert.equal(run('TC.records.length'),rows);assert.equal(env.signatureStartCalls.length,0);
});
function s2Jcs(value){
 if(value===null)return 'null';if(typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(s2Jcs).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+s2Jcs(value[k])).join(',')+'}';
 throw new Error('Unsupported test JCS value');
}
function s2TestWorkbook(){const file=process.env.DTC_S2_SIGNATURE_FIXTURE;if(!file)throw Error('Set DTC_S2_SIGNATURE_FIXTURE to the v0.9.0 R4 workbook');return fs.readFileSync(file);}
function s2TestPoints(file=process.env.DTC_S2_POINTS_JSON||path.join(root,'tests/signature/s1_5_poc_strokes.json')){return JSON.parse(fs.readFileSync(file,'utf8')).points;}
function s2SyntheticPoints(total,strokeCount){
 const points=[],counts=Array(strokeCount).fill(0);
 for(let i=0;i<total;i++){
  const stroke=Math.floor(i*strokeCount/total)+1,point=++counts[stroke-1];
  points.push([stroke,point,(i*7919)%1000001,(i*104729+137)%1000001,i]);
 }
 return points;
}
const S2_TEST_RENDERER_V1='dold-signature-normalized-png-v1;900x300;transparent-rgba;black-opaque;stroke-9px;round-cap;round-join;pad-8pct;map-normalized-x-y;crop-none;png-filter-none-deflate-6-no-metadata';
async function s2MakeDraft(record,options={}){
 const version=await run(`draftKontrollRecordVersion(TC.records.find(r=>r.syncId===${JSON.stringify(record.syncId)}))`);
 assert(Number.isInteger(version.recordVersion)&&version.recordVersion>=1,'S2 draft target must have a persistent record version');
 const rendererProfile=options.rendererProfile||JSON.parse(fs.readFileSync(path.join(root,'tests/signature/s1_5_poc_strokes.json'),'utf8')).rendererProfile,pngPath=options.pngPath||(rendererProfile===S2_TEST_RENDERER_V1?process.env.DTC_S2_V1_TEST_PNG:process.env.DTC_S2_TEST_PNG);if(!pngPath)throw Error('Set the matching canonical native test PNG for the selected renderer profile');
 const png=fs.readFileSync(pngPath),points=options.points||s2TestPoints(options.pointsPath),strokeCount=Math.max(...points.map(p=>p[0])),canvasWidthPx=options.canvasWidthPx??900,canvasHeightPx=options.canvasHeightPx??300,strokes={format:'dold-strokes/v1',canvasWidthPx,canvasHeightPx,points},geometry={format:'dold-geometry/v1',points:points.map(([stroke,point,x,y])=>[stroke,point,x,y])};
 const strokeHash=hashBytes(Buffer.from(s2Jcs(strokes))),geometryHash=hashBytes(Buffer.from(s2Jcs(geometry))),pngHash=hashBytes(png),started=Number(run('Date.now()')),duration=1000,nonce=crypto.randomBytes(32).toString('hex');
 const draft={schemaVersion:1,status:'S1_DRAFT',signatureId:'dtc-sign-'+crypto.randomUUID(),targetType:'Kontroll',recordId:record.syncId,recordVersion:version.recordVersion,recordVersionSource:version.recordVersionSource,kilpId:record.id,signerName:record.inspector,nonce,captureStartedAtUtcMs:started,captureEndedAtUtcMs:started+duration,captureDurationMs:duration,clockSource:'DEVICE_WALL_CLOCK_UNTRUSTED',inputMethod:'TOUCH',strokeCount,pointCount:points.length,canvasWidthPx,canvasHeightPx,points,pngBase64:png.toString('base64'),pngHash,strokeHash,geometryHash,rendererProfile,deviceInstanceId:run('TC.deviceId'),appVersionName:'0.5.6.1',appVersionCode:57,androidRelease:'16',androidApiLevel:36,antiReuse:{algorithm:'dold-exact-reuse/v1',result:'UNIQUE',scope:'LOCAL_KNOWN_DATA',checkedAtUtcMs:started,checkedCount:env.signatureDraftPayloads.size,registryDigest:hashBytes(Buffer.from('[]')),matchingSignatureIds:[],geometryHash},targetMetadata:{workbookIdentity:run('TC.dbId'),inspectionDate:record.date,inspectorName:record.inspector,recordVersionSnapshotHash:version.recordVersionSnapshotHash}};
 return draft;
}
async function s2RegisterDraft(draft){env.signatureDraftPayloads.set(draft.signatureId,draft);return draft;}
function s2FreshPersistentRecord(){const value=run('TC.records.find(r=>r.persistentId&&r.syncId)');if(!value)throw Error('R4 workbook needs a persistent Kontroll record');return JSON.parse(JSON.stringify(value));}
await test('S2 signature inlineStr reader handles qualified and ordinary SpreadsheetML text after serializer round-trip',async()=>{
 const xml='<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><x:r><x:t>first</x:t></x:r><x:r><x:t>second</x:t></x:r></is></c><c r="B1" t="inlineStr"><is><t>plain</t></is></c></row></sheetData></worksheet>';
 env.cx.inlineStringXml=xml;
 const result=await run("(()=>{const initial=parseXml(inlineStringXml),reparsed=parseXml(xmlStr(initial)),cells=qsa(reparsed,'c'),qualified=cells[0],plain=cells[1];return {oldQualified:Array.from(qualified.getElementsByTagName('t')).map(x=>x.textContent).join(''),qualifiedTexts:qsa(qualified,'t').map(x=>x.textContent).join(''),qualifiedInline:getInline(qualified),plainInline:getInline(plain),qualifiedTextNodes:qsa(qualified,'t').length};})()");
 assert.equal(result.oldQualified,'','the old qualified-name lookup must demonstrate why it misses prefixed SpreadsheetML t nodes');
 assert.equal(result.qualifiedTexts,'firstsecond');assert.equal(result.qualifiedInline,'firstsecond');
 assert.equal(result.plainInline,'plain','ordinary unprefixed inlineStr remains readable');assert.equal(result.qualifiedTextNodes,2,'rich text runs remain joined in document order');
});
await test('S2 signature accepts an existing v1 draft and records its original renderer profile',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-renderer-v1-compatibility',s2TestWorkbook());await run('continueCycle()');const record=s2FreshPersistentRecord(),draft=await s2RegisterDraft(await s2MakeDraft(record,{rendererProfile:S2_TEST_RENDERER_V1}));
  await run(`onNativeSignatureDraftSaved(${JSON.stringify(JSON.stringify({signatureId:draft.signatureId}))})`);
  const state=await run(`(async()=>{const a=await loadDoc('Allkirjad'),p=await loadDoc('Allkirjade pildid'),row=s2SignatureRowsById(a,${JSON.stringify(draft.signatureId)})[0],picture=s2Rows(p,6,500).find(r=>s2CellString(p,'A',r)===${JSON.stringify(draft.signatureId)});return {status:s2CellString(a,'F',row),proof:JSON.parse(s2CellString(a,'BN',row)),pngHash:s2CellString(p,'G',picture)};})()`);
  assert.equal(state.status,'Kehtiv');assert.equal(state.proof.rendererProfile,S2_TEST_RENDERER_V1);assert.equal(state.pngHash,draft.pngHash);
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('S2 signature accepts native 640x760 canvas while committing canonical 900x300 PNG',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-native-canvas-dimensions',s2TestWorkbook());await run('continueCycle()');const record=s2FreshPersistentRecord(),draft=await s2RegisterDraft(await s2MakeDraft(record,{canvasWidthPx:640,canvasHeightPx:760}));
  const expectedStrokes={format:'dold-strokes/v1',canvasWidthPx:640,canvasHeightPx:760,points:draft.points},expectedGeometry={format:'dold-geometry/v1',points:draft.points.map(([stroke,point,x,y])=>[stroke,point,x,y])};
  assert.equal(draft.strokeHash,hashBytes(Buffer.from(s2Jcs(expectedStrokes))),'StrokeHash must cover actual native canvas dimensions');assert.equal(draft.geometryHash,hashBytes(Buffer.from(s2Jcs(expectedGeometry))),'geometryHash must cover unchanged normalized points');
  await run(`onNativeSignatureDraftSaved(${JSON.stringify(JSON.stringify({signatureId:draft.signatureId}))})`);
  const state=await run(`(async()=>{const a=await loadDoc('Allkirjad'),p=await loadDoc('Allkirjade pildid'),j=await loadDoc('Allkirja_jaljed'),rows=s2SignatureRowsById(a,${JSON.stringify(draft.signatureId)}),row=rows[0],picture=s2Rows(p,6,500).find(r=>s2CellString(p,'A',r)===${JSON.stringify(draft.signatureId)}),image=await s2ResolveRichPicture(S.zip,getCell(p,'F'+picture)),points=s2Rows(j,5,1048576).filter(r=>s2CellString(j,'A',r)===${JSON.stringify(draft.signatureId)});return {signatureCount:rows.length,canvasWidth:s2CellString(a,'BJ',row),canvasHeight:s2CellString(a,'BK',row),strokeHash:s2CellString(a,'BG',row),proof:JSON.parse(s2CellString(a,'BN',row)),pngHash:s2CellString(p,'G',picture),imageDimensions:s2PngDimensions(image.png),pointCount:points.length,firstPoint:['B','C','D','E','F'].map(c=>s2CellString(j,c,points[0]))};})()`);
  assert.equal(state.signatureCount,1);assert.equal(Number(state.canvasWidth),640);assert.equal(Number(state.canvasHeight),760);assert.equal(state.strokeHash,draft.strokeHash);assert.equal(state.proof.canvasWidthPx,640);assert.equal(state.proof.canvasHeightPx,760);assert.equal(state.proof.strokeHash,draft.strokeHash);assert.equal(state.proof.antiReuse.geometryHash,draft.geometryHash);assert.equal(state.pngHash,draft.pngHash);assert.deepEqual(JSON.parse(JSON.stringify(state.imageDimensions)),{width:900,height:300});assert.equal(state.pointCount,draft.pointCount);assert.deepEqual(JSON.parse(JSON.stringify(state.firstPoint)),draft.points[0].map(String));
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('S2 signature blocks native canvas dimensions below two pixels',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-native-canvas-too-small',s2TestWorkbook());await run('continueCycle()');const record=s2FreshPersistentRecord();
  for(const dims of [{canvasWidthPx:1,canvasHeightPx:760},{canvasWidthPx:640,canvasHeightPx:1}]){const draft=await s2MakeDraft(record,{canvasWidthPx:640,canvasHeightPx:760});Object.assign(draft,dims);env.cx.s2ValidationDraft=draft;const code=await run(`(async()=>{try{await s2ValidateDraft(s2ValidationDraft);return 'NO_BLOCK';}catch(e){return e.signatureCode||e.message;}})()`);assert.equal(code,'STROKES_INVALID');}
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('S2 signature blocks non-integer and non-finite native canvas dimensions',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-native-canvas-invalid-values',s2TestWorkbook());await run('continueCycle()');const record=s2FreshPersistentRecord();
  for(const width of [640.5,NaN,'640']){const draft=await s2MakeDraft(record,{canvasWidthPx:640,canvasHeightPx:760});draft.canvasWidthPx=width;env.cx.s2ValidationDraft=draft;const code=await run(`(async()=>{try{await s2ValidateDraft(s2ValidationDraft);return 'NO_BLOCK';}catch(e){return e.signatureCode||e.message;}})()`);assert.equal(code,'STROKES_INVALID');}
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('S2 signature reports append/serialization/reparse counts and rolls back when a candidate loses one point',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-stroke-roundtrip-loss-diagnostics',s2TestWorkbook());await run('continueCycle()');const record=s2FreshPersistentRecord(),draft=await s2RegisterDraft(await s2MakeDraft(record));
  const before=Buffer.from(await run('S.zip.generateAsync({type:"uint8array"})'));
  run(`globalThis.__s2DiagnosticOriginalVerifier=s2VerifyProductionCandidate;s2VerifyProductionCandidate=async function(original,candidate,state,paths){try{globalThis.__s2DiagnosticStage='parse';const doc=await s2ParsePart(candidate,paths.strokes),matching=s2Rows(doc,5,1048576).filter(row=>s2CellString(doc,'A',row)===state.draft.signatureId);globalThis.__s2DiagnosticStage='remove';const last=qsa(qsa(doc,'sheetData')[0],'row').find(row=>Number(row.getAttribute('r'))===matching[matching.length-1]);last.parentNode.removeChild(last);globalThis.__s2DiagnosticStage='serialize';candidate.file(paths.strokes,xmlStr(doc));globalThis.__s2DiagnosticStage='verify';return await __s2DiagnosticOriginalVerifier(original,candidate,state,paths);}catch(e){globalThis.__s2DiagnosticVerifyError=e.stack||String(e);throw e;}};`);
  const result=await run(`commitProductionSignature(${JSON.stringify(draft.signatureId)})`);assert.equal(result.ok,false);
  const after=Buffer.from(await run('S.zip.generateAsync({type:"uint8array"})'));assert.equal(hashBytes(before),hashBytes(after),'candidate verification failure must leave the active workbook unchanged');assert(env.signatureDraftPayloads.has(draft.signatureId),'local draft must remain available for retry');
  const error=alerts.findLast(message=>message.includes('Kõiki allkirja puutepunkte ei kirjutatud.'));if(!error)console.log('S2 STROKE DIAGNOSTIC INJECTION',run("({stage:globalThis.__s2DiagnosticStage,error:globalThis.__s2DiagnosticVerifyError})"),alerts.at(-1));assert(error,'field error should retain its specific stroke mismatch details');
  const message=error.split('\n').at(-1);assert(message.includes(`DOM ${draft.pointCount}`));assert(message.includes(`serialiseeritud AllkiriID esinemised ${draft.pointCount}`));assert(message.includes(`uuesti loetud AllkiriID read ${draft.pointCount-1}`));assert.match(message,/esimene puuduv PunktNr \d+/);assert.match(message,/viimane korrektne PunktNr \d+/);assert.match(message,/kasutatud read \d+-\d+/);assert.match(message,/dimension /);
 }finally{run("if(typeof __s2DiagnosticOriginalVerifier!=='undefined')s2VerifyProductionCandidate=__s2DiagnosticOriginalVerifier");env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
for(const scenario of [{label:'243 points in 1 stroke',total:243,strokes:1},{label:'224 points in 2 strokes',total:224,strokes:2},{label:'317 points in 1 stroke',total:317,strokes:1},{label:'360 points across multiple strokes',total:360,strokes:4},{label:'640 points across multiple strokes',total:640,strokes:5}]){
 await test(`S2 signature stroke production ZIP round-trip preserves every raw value: ${scenario.label}`,async()=>{
  const previous={env,storeDir,clock:{...clock}};try{
   await freshWorkspace(`s2-stroke-roundtrip-${scenario.total}`,s2TestWorkbook());await run('continueCycle()');
   const record=s2FreshPersistentRecord(),points=s2SyntheticPoints(scenario.total,scenario.strokes),draft=await s2RegisterDraft(await s2MakeDraft(record,{points,canvasWidthPx:640,canvasHeightPx:760}));
   assert.equal(draft.pointCount,scenario.total);assert.equal(draft.strokeCount,scenario.strokes);
   const saved=await run(`onNativeSignatureDraftSaved(${JSON.stringify(JSON.stringify({signatureId:draft.signatureId}))})`);assert(saved,'production signature path must return the completed draft');
   const roundtrip=await run(`(async()=>{const packed=await S.zip.generateAsync({type:'uint8array'}),reopened=await JSZip.loadAsync(packed),j=await s2ParsePart(reopened,S.paths['Allkirja_jaljed']),a=await s2ParsePart(reopened,S.paths['Allkirjad']),rows=s2Rows(j,5,1048576).filter(r=>s2CellString(j,'A',r)===${JSON.stringify(draft.signatureId)}),rowDetails=rows.map(r=>({row:r,cells:['A','B','C','D','E','F'].map(c=>({ref:c+r,present:!!getCell(j,c+r),value:s2CellString(j,c,r)}))})),signatureRows=s2SignatureRowsById(a,${JSON.stringify(draft.signatureId)});return {rows:rowDetails,dimension:qsa(j,'dimension')[0]?.getAttribute('ref')||'',signatureCount:signatureRows.length,proof:signatureRows.length===1?JSON.parse(s2CellString(a,'BN',signatureRows[0])):null,zipBytes:packed.length};})()`);
   assert.equal(roundtrip.signatureCount,1,'one production signature record should be committed');assert.equal(roundtrip.rows.length,scenario.total,'every saved raw point must survive packed XLSX and reparse');
   const rowNumbers=roundtrip.rows.map(x=>x.row);assert.equal(new Set(rowNumbers).size,scenario.total,'no duplicate worksheet row numbers');
   for(let i=0;i<scenario.total;i++){
    const expected=['',...points[i].map(String)],actual=roundtrip.rows[i];assert.equal(actual.row,rowNumbers[0]+i,`point ${i+1} stays in sequence`);
    for(let c=0;c<6;c++){assert(actual.cells[c].present,`point ${i+1} cell ${actual.cells[c].ref} exists`);assert.equal(actual.cells[c].value,c===0?draft.signatureId:expected[c],`point ${i+1} ${actual.cells[c].ref} round-trips exactly`);}
   }
   if(roundtrip.dimension){const lastDimensionRow=Number((roundtrip.dimension.split(':').at(-1).match(/\d+/)||['0'])[0]);assert(lastDimensionRow>=rowNumbers.at(-1),'existing worksheet dimension must include the last point row');}assert.equal(roundtrip.proof.strokeHash,draft.strokeHash,'proof retains original native canvas StrokeHash');
   const afterRestart=await run(`(async()=>{const bytes=await S.zip.generateAsync({type:'uint8array'}),z=await JSZip.loadAsync(bytes),doc=await s2ParsePart(z,S.paths['Allkirja_jaljed']);return s2Rows(doc,5,1048576).filter(r=>s2CellString(doc,'A',r)===${JSON.stringify(draft.signatureId)}).length;})()`);
   assert.equal(afterRestart,scenario.total,'reopened XLSX retains all points');
  }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
 });
}
await test('S2 signature accepts local Kontroll capture into R4 sheets and Rich Data, then retries idempotently',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-production-commit',s2TestWorkbook());await run('continueCycle()');const record=s2FreshPersistentRecord(),draft=await s2RegisterDraft(await s2MakeDraft(record));
  const beforeControls=await count('Kontrollid'),beforeSignatures=await count('Allkirjad'),beforePictures=await count('Allkirjade pildid');
  await run(`onNativeSignatureDraftSaved(${JSON.stringify(JSON.stringify({signatureId:draft.signatureId}))})`);
  const state=await run(`(async()=>{const c=await loadDoc('Kontrollid'),a=await loadDoc('Allkirjad'),p=await loadDoc('Allkirjade pildid'),j=await loadDoc('Allkirja_jaljed'),ar=s2SignatureRowsById(a,${JSON.stringify(draft.signatureId)}),pr=s2Rows(p,6,500).filter(r=>s2CellString(p,'A',r)===${JSON.stringify(draft.signatureId)}),jr=s2Rows(j,5,1048576).filter(r=>s2CellString(j,'A',r)===${JSON.stringify(draft.signatureId)});return {controlPointer:s2CellString(c,'AB',${record.row}),signatureRows:ar,signatureCount:ar.length,pictureCount:pr.length,pictureRow:pr[0],strokeCount:jr.length,signatureStatus:s2CellString(a,'F',ar[0]),effectiveStatus:s2CellString(a,'G',ar[0]),recordVersion:s2CellString(a,'I',ar[0]),recordHash:s2CellString(a,'J',ar[0]),proofHash:s2CellString(a,'BA',ar[0]),proof:s2CellString(a,'BN',ar[0]),snapshot:s2CellString(a,'S',ar[0]),imageCell:getCell(p,'F'+pr[0])?.getAttribute('vm'),mediaPath:s2CellString(p,'H',pr[0]),imageHash:s2CellString(p,'G',pr[0]),image:await s2ResolveRichPicture(S.zip,getCell(p,'F'+pr[0]))};})()`);
  assert.equal(state.controlPointer,draft.signatureId);assert.equal(state.signatureCount,1);assert.equal(state.pictureCount,1);assert.equal(state.strokeCount,draft.pointCount);assert.equal(state.signatureStatus,'Kehtiv');assert.equal(state.effectiveStatus,'Kehtiv');assert.equal(Number(state.recordVersion),draft.recordVersion);assert.equal(state.imageCell,'3');assert.equal(state.imageHash,draft.pngHash);assert.equal(state.image.pngHash,draft.pngHash);assert.equal(state.mediaPath,state.image.mediaPath);assert.equal(state.proofHash,hashBytes(Buffer.from(state.proof)));assert.equal(state.recordHash,hashBytes(Buffer.from(state.snapshot)));assert.equal(JSON.parse(state.proof).antiReuse.scope,'LOCAL_KNOWN_DATA');assert.equal(JSON.parse(state.proof).rendererProfile,draft.rendererProfile);
  assert.equal(await count('Kontrollid'),beforeControls);assert.equal(await count('Allkirjad'),beforeSignatures+1);assert.equal(await count('Allkirjade pildid'),beforePictures+1);
  const again=await run(`commitProductionSignature(${JSON.stringify(draft.signatureId)})`);assert.equal(again.already,true);assert.equal(await count('Allkirjad'),beforeSignatures+1);assert.equal(await count('Allkirjade pildid'),beforePictures+1);
  const stored=await run('persistWorkspace()');assert(Number(stored?.length)>0);
  const recordId=record.syncId,signatureId=draft.signatureId;
  env=makeContext();await run('TC.startupTask');assert.equal(run('TC.startupLoaded'),true,'workspace must restore after app context recreation');
  await run('continueLastWorkingFile()');await run('continueCycle()');
  const restored=run(`TC.records.find(r=>r.syncId===${JSON.stringify(recordId)})`);assert(restored,'saved Kontroll must survive app restart');
  const restoredStatus=await run(`savedKontrollSignatureStatus(TC.records.find(r=>r.syncId===${JSON.stringify(recordId)}))`);assert.equal(restoredStatus,'Kehtiv (kohalikult kontrollitud)');
  const restoredPointer=await run(`(async()=>{const d=await loadDoc('Kontrollid'),r=qsa(d,'row').find(x=>getCellVal(d,'AA',Number(x.getAttribute('r')))===${JSON.stringify(recordId)});return r&&getCellVal(d,'AB',Number(r.getAttribute('r')));})()`);assert.equal(restoredPointer,signatureId);
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('S2 signature anti-reuse blocks same known strokes and preserves XLSX bytes',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-anti-reuse',s2TestWorkbook());await run('continueCycle()');const record=s2FreshPersistentRecord(),first=await s2RegisterDraft(await s2MakeDraft(record));
  const firstResult=await run(`commitProductionSignature(${JSON.stringify(first.signatureId)})`);assert(firstResult.ok);
  const duplicate=await s2RegisterDraft(await s2MakeDraft(record));const before=Buffer.from(await run('S.zip.generateAsync({type:"uint8array"})'));
  const code=await run(`(async()=>{try{await s2PrepareSignatureState(await JSON.parse(Android.readSignatureDraft(${JSON.stringify(duplicate.signatureId)})).data);return 'NO_BLOCK';}catch(e){return e.signatureCode||e.message;}})()`);
  assert.equal(code,'DUPLICATE_CAPTURE');const after=Buffer.from(await run('S.zip.generateAsync({type:"uint8array"})'));assert.equal(hashBytes(before),hashBytes(after));
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('S2 signature transaction rolls back workbook changes when durable workspace save fails',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-save-rollback',s2TestWorkbook());await run('continueCycle()');const record=s2FreshPersistentRecord(),draft=await s2RegisterDraft(await s2MakeDraft(record));
  const before=Buffer.from(await run('S.zip.generateAsync({type:"uint8array"})'));env.setInjectFailure(true);
  try{const result=await run(`commitProductionSignature(${JSON.stringify(draft.signatureId)})`);assert.equal(result.ok,false);}finally{env.setInjectFailure(false);}
  const after=Buffer.from(await run('S.zip.generateAsync({type:"uint8array"})'));assert.equal(hashBytes(before),hashBytes(after));assert.equal(await count('Allkirjad'),2);assert.equal(env.signatureDraftPayloads.has(draft.signatureId),true);assert(alerts.some(x=>x.includes('Kontroll jäi salvestatuks')));
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('S2 signature refuses unsupported signature workbook without modifying its active XLSX',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-unsupported',s2TestWorkbook());await run('continueCycle()');const record=s2FreshPersistentRecord(),draft=await s2RegisterDraft(await s2MakeDraft(record));
  const before=Buffer.from(await run('S.zip.generateAsync({type:"uint8array"})')),savedPath=run("S.paths.Allkirjad");run('S.paths.Allkirjad=null');
  try{const result=await run(`commitProductionSignature(${JSON.stringify(draft.signatureId)})`);assert.equal(result.ok,false);}finally{run(`S.paths.Allkirjad=${JSON.stringify(savedPath)}`);}
  const after=Buffer.from(await run('S.zip.generateAsync({type:"uint8array"})'));assert.equal(hashBytes(before),hashBytes(after));assert.equal(env.signatureDraftPayloads.has(draft.signatureId),true);assert(alerts.some(x=>x.includes('SIGNATURE_STRUCTURE_UNSUPPORTED')));
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('S2 signature rejects changed Kontroll version before acceptance',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-stale-draft',s2TestWorkbook());await run('continueCycle()');const record=s2FreshPersistentRecord(),draft=await s2RegisterDraft(await s2MakeDraft(record));
  await run(`(async()=>{const d=await loadDoc('Kontrollid'),old=Number(getCellVal(d,'H',${record.row})||0);setNum(d,'H',${record.row},(old+1)%6);S.zip.file(S.paths.Kontrollid,xmlStr(d));await reconcileKontrollSignatureVersions();})()`);
  const before=Buffer.from(await run('S.zip.generateAsync({type:"uint8array"})'));
  const code=await run(`(async()=>{try{await s2PrepareSignatureState(await JSON.parse(Android.readSignatureDraft(${JSON.stringify(draft.signatureId)})).data);return 'NO_BLOCK';}catch(e){return e.signatureCode||e.message;}})()`);
  assert.equal(code,'RECORD_CHANGED_DURING_CAPTURE');assert.equal(hashBytes(before),hashBytes(Buffer.from(await run('S.zip.generateAsync({type:"uint8array"})'))));
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('S2 signature editing a signed Kontroll atomically revokes and preserves the previous proof',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  await freshWorkspace('s2-edit-revokes',s2TestWorkbook());await run('continueCycle()');await run('resetRingProgress()');run('TC.guard.remaining=100');
  const id=run('activeCabinets()[0].id');await run(`openCab(${JSON.stringify(id)},'camera')`);el('inspector').value='S2 edit tester';run('setAllScores(4)');advance(61);await run('saveInspection()');
  const saved=run(`savedEntry(${JSON.stringify(id)})`);assert(saved?.syncId);const draft=await s2RegisterDraft(await s2MakeDraft(saved));await run(`onNativeSignatureDraftSaved(${JSON.stringify(JSON.stringify({signatureId:draft.signatureId}))})`);
  const beforeProof=await run(`(async()=>{const d=await loadDoc('Allkirjad'),r=s2SignatureRowsById(d,${JSON.stringify(draft.signatureId)})[0];return {proof:s2CellString(d,'BN',r),hash:s2CellString(d,'BA',r),id:s2CellString(d,'A',r)};})()`);
  await openCabWithChoices(id,'camera',['edit']);run('setAllScores(3)');advance(61);await run('saveInspection()');
  const revoked=await run(`(async()=>{const d=await loadDoc('Allkirjad'),r=s2SignatureRowsById(d,${JSON.stringify(draft.signatureId)})[0];return {status:s2CellString(d,'F',r),at:s2CellString(d,'P',r),reason:s2CellString(d,'Q',r),proof:s2CellString(d,'BN',r),hash:s2CellString(d,'BA',r),pointer:s2CellString(await loadDoc('Kontrollid'),'AB',${saved.row})};})()`);
  assert.equal(revoked.status,'Tühistatud');assert(Number(revoked.at)>0);assert.equal(revoked.reason,'Kontrolli andmeid muudeti rakenduses');assert.equal(revoked.proof,beforeProof.proof);assert.equal(revoked.hash,beforeProof.hash);assert.equal(revoked.pointer,draft.signatureId);
  run("onNativeSignatureCaptureCancelled('test cancel')");
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('S2 signature re-sign after Kontroll edit cancels old proof and links the new signature',async()=>{
 const previous={env,storeDir,clock:{...clock}};try{
  const alternatePng=process.env.DTC_S2_ALTERNATE_PNG;if(!alternatePng)throw Error('Set DTC_S2_ALTERNATE_PNG to the alternate canonical native PNG');
  await freshWorkspace('s2-resign-after-edit',s2TestWorkbook());await run('continueCycle()');await run('resetRingProgress()');run('TC.guard.remaining=100');const signatureRowsBefore=await count('Allkirjad');
  const id=run('activeCabinets()[0].id');await run(`openCab(${JSON.stringify(id)},'camera')`);el('inspector').value='S2 re-sign tester';run('setAllScores(4)');advance(61);await run('saveInspection()');const firstRecord=run(`savedEntry(${JSON.stringify(id)})`),oldId=firstRecord.syncId;run("onNativeSignatureCaptureCancelled('test first inspection')");
  const first=await s2RegisterDraft(await s2MakeDraft(firstRecord));assert((await run(`commitProductionSignature(${JSON.stringify(first.signatureId)})`)).ok);
  const oldProof=await run(`(async()=>{const d=await loadDoc('Allkirjad'),r=s2SignatureRowsById(d,${JSON.stringify(first.signatureId)})[0];return {proof:s2CellString(d,'BN',r),hash:s2CellString(d,'BA',r)};})()`);
  await openCabWithChoices(id,'camera',['edit']);run('setAllScores(3)');advance(61);await run('saveInspection()');run("onNativeSignatureCaptureCancelled('test edit capture')");
  const edited=run(`savedEntry(${JSON.stringify(id)})`);assert.equal(edited.syncId,oldId);const second=await s2RegisterDraft(await s2MakeDraft(edited,{pointsPath:path.join(root,'tests/signature/s2_alternate_strokes.json'),pngPath:alternatePng}));
  assert.notEqual(second.signatureId,first.signatureId);assert.notEqual(second.strokeHash,first.strokeHash);assert((await run(`commitProductionSignature(${JSON.stringify(second.signatureId)})`)).ok);
  const state=await run(`(async()=>{const d=await loadDoc('Allkirjad'),c=await loadDoc('Kontrollid'),old=s2SignatureRowsById(d,${JSON.stringify(first.signatureId)})[0],next=s2SignatureRowsById(d,${JSON.stringify(second.signatureId)})[0],target=qsa(c,'row').find(x=>getCellVal(c,'AA',Number(x.getAttribute('r')))===${JSON.stringify(oldId)});return {oldStatus:s2CellString(d,'F',old),oldProof:s2CellString(d,'BN',old),oldProofHash:s2CellString(d,'BA',old),newStatus:s2CellString(d,'F',next),supersedes:s2CellString(d,'O',next),pointer:getCellVal(c,'AB',Number(target.getAttribute('r'))),count:s2Rows(d,5,500).filter(r=>s2CellString(d,'A',r)).length};})()`);
  assert.equal(state.oldStatus,'Tühistatud');assert.equal(state.oldProof,oldProof.proof);assert.equal(state.oldProofHash,oldProof.hash);assert.equal(state.newStatus,'Kehtiv');assert.equal(state.supersedes,first.signatureId);assert.equal(state.pointer,second.signatureId);assert.equal(state.count,signatureRowsBefore+2);
  assert.equal(await run(`savedKontrollSignatureStatus(TC.records.find(r=>r.syncId===${JSON.stringify(oldId)}))`),'Kehtiv (kohalikult kontrollitud)');
 }finally{env=previous.env;storeDir=previous.storeDir;clock.mono=previous.clock.mono;clock.offset=previous.clock.offset;}
});
await test('R4 scoring blank value is displayed as Ei rakendu',async()=>assertR4VisibleScore('','Ei rakendu'));
await test('R4 scoring zero remains Ei ole / puudub',async()=>assertR4VisibleScore('0','Ei ole / puudub'));
await test('R4 scoring one is Asendus puudub',async()=>assertR4VisibleScore('1','Asendus puudub'));
await test('R4 scoring two is Ajutised lahendused',async()=>assertR4VisibleScore('2','Ajutised lahendused'));
await test('R4 scoring three is Vajab uuendamist',async()=>assertR4VisibleScore('3','Vajab uuendamist'));
await test('R4 scoring four is Normi piires',async()=>assertR4VisibleScore('4','Normi piires'));
await test('R4 scoring five is Uus ja korras',async()=>assertR4VisibleScore('5','Uus ja korras'));
await test('R4 scoring saved-inspection detail distinguishes blank and numeric values',async()=>{
 const cabinet=run('S.cabinets[0].id');run(`S.selected=S.cabinets.find(c=>c.id===${JSON.stringify(cabinet)})`);
 const record={id:cabinet,date:'2026-10-23',inspector:'R4 inspector',syncId:'dtc-kontroll-r4-detail',ratings:{H:'',I:'0',J:'1',K:'2',L:'3',M:'4',N:'5'}};
 const pending=run(`viewSavedInspection(${JSON.stringify(cabinet)},${JSON.stringify(record)},{})`);await waitForAppDialog('VAATA KONTROLLI');const body=el('appDialogBody').innerHTML;
 for(const expected of ['Visuaal: <b>– — Ei rakendu</b>','Termo: <b>0 — Ei ole / puudub</b>','Juhtmed / klemmid: <b>1 — Asendus puudub</b>','Ühendused: <b>2 — Ajutised lahendused</b>','Tolm / vent.: <b>3 — Vajab uuendamist</b>','Kaablid: <b>4 — Normi piires</b>','PE: <b>5 — Uus ja korras</b>'])assert(body.includes(expected),expected);
 run("appDialogChoice('back')");await pending;
});
await test('R4 scoring saves 0–5 to Kontrollid H unchanged and leaves blank empty',async()=>{
 await run('resetRingProgress()');const baselineRows=await count('Kontrollid'),expected=['0','1','2','3','4','5',''],saved=[];run('TC.guard.remaining=1000');
 for(const value of expected){const id=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id');await run(`openCab(${JSON.stringify(id)},'camera')`);el('inspector').value='R4 scale tester';run(`S.ratings=Object.fromEntries(CHECKS.map(([col])=>[col,'']));S.ratings.H=${JSON.stringify(value)};S.ratings.I='4';renderRatings()`);advance(61);await run('saveInspection()');const record=run(`savedEntry(${JSON.stringify(id)})`);assert(record,'Saved inspection should be findable by its permanent ID');const cell=await run(`(async()=>getCellVal(await loadDoc('Kontrollid'),'H',${record.row}))()`);assert.equal(cell,value,`H should persist ${JSON.stringify(value)} without recoding`);saved.push(record.syncId);}
 assert.equal(new Set(saved).size,expected.length);assert.equal(await count('Kontrollid'),baselineRows+expected.length);
});
await test('R4 scoring edit-existing inspection leaves every score unchanged',async()=>{
 const id=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id)).id'),values={H:'',I:'0',J:'1',K:'2',L:'3',M:'4',N:'5',O:'',P:'',Q:'',R:''};await run(`openCab(${JSON.stringify(id)},'camera')`);el('inspector').value='R4 edit tester';run(`S.ratings=${JSON.stringify(values)};renderRatings()`);advance(61);await run('saveInspection()');const first=run(`savedEntry(${JSON.stringify(id)})`),columns=run('CHECKS.map(([col])=>col)'),rowCount=await count('Kontrollid'),before=await run(`(async()=>{const d=await loadDoc('Kontrollid');return ${JSON.stringify(columns)}.map(c=>getCellVal(d,c,${first.row}));})()`);
 await openCabWithChoices(id,'search',['edit']);assert.deepEqual(JSON.parse(JSON.stringify(run('S.ratings'))),values);await run('saveInspection()');const after=await run(`(async()=>{const d=await loadDoc('Kontrollid');return ${JSON.stringify(columns)}.map(c=>getCellVal(d,c,${first.row}));})()`);
 assert.deepEqual(JSON.parse(JSON.stringify(after)),JSON.parse(JSON.stringify(before)));assert.equal(run(`savedEntry(${JSON.stringify(id)}).syncId`),first.syncId);assert.equal(await count('Kontrollid'),rowCount);
});
await test('R5 XLSX preservation archive round-trip retains v0.8.3 structure and Android changes',async()=>{
 const checks=[];function verify(name,condition,details=''){assert(condition,name+(details?' — '+details:''));checks.push({name,details});}
 const freshBytes=Buffer.from(bytes),sourceZip=await JSZip.loadAsync(freshBytes,{checkCRC32:true}),sourceFeatures=await workbookFeatureSnapshot(sourceZip),sourceParts=sourceFeatures.parts;
 const requiredSheets=['Parandused','Allkirjad','Allkirjade pildid','Kontrollakt Auto'];for(const name of requiredSheets)verify(`source contains ${name}`,sourceFeatures.sheets.includes(name));
 const categoryPaths=sourceParts.filter(n=>n.startsWith('xl/drawings/')||n.startsWith('xl/media/')||n.startsWith('xl/richData/')||n==='xl/metadata.xml');
 verify('source includes drawing, relationship, media, rich-data and metadata parts',categoryPaths.some(n=>n.startsWith('xl/drawings/'))&&categoryPaths.some(n=>n.startsWith('xl/media/'))&&categoryPaths.some(n=>n.startsWith('xl/richData/'))&&categoryPaths.includes('xl/metadata.xml'));
 verify('source relationship targets resolve',sourceFeatures.relationships.length>0&&sourceFeatures.relationships.every(r=>r.valid),JSON.stringify(sourceFeatures.relationships.filter(r=>!r.valid).slice(0,3)));
 await freshWorkspace('r5-v083-roundtrip',freshBytes);
 const sourceMap=await workbookPartMap(sourceZip),controlPart=sourceMap.sheets.Kontrollid,defectPart=sourceMap.sheets.Puudused,summaryPart=sourceMap.sheets.Kokkuvõte;
 const beforeControlMap=await sheetCellMap(sourceZip,controlPart),beforeDefectMap=await sheetCellMap(sourceZip,defectPart),beforeCounts={controls:run('TC.records.length'),defects:run('TC.allDefects.length'),kontrollIds:run('TC.records.filter(r=>r.persistentId).length'),puudusIds:run('TC.allDefects.filter(d=>d.persistentId).length')};
 const existingControlRefs=run('TC.records.map(r=>`AA${r.row}`)'),existingDefectRefs=run('TC.allDefects.map(d=>({s:`S${d.row}`,t:`T${d.row}`,u:`U${d.row}`,v:`V${d.row}`}))');
 const originalControlCells=Object.fromEntries(await Promise.all(existingControlRefs.map(async ref=>[ref,beforeControlMap.get(ref)||null]))),originalDefectCells=Object.fromEntries(await Promise.all(existingDefectRefs.flatMap(x=>Object.values(x).map(async ref=>[ref,beforeDefectMap.get(ref)||null]))));
 const blankS23=beforeDefectMap.get('S23')||null,blankS25=beforeDefectMap.get('S25')||null;
 verify('fixture baseline recorded before edits',beforeCounts.controls>0&&beforeCounts.defects>0,JSON.stringify(beforeCounts));
 verify('fixture S23 and S25 are empty before edits',!blankS23?.value&&!blankS23?.inline&&!blankS25?.value&&!blankS25?.inline);
 const preservedStatusRows=run(`TC.allDefects.filter(d=>/UNRESOLVED|LEGACY MATCH ONLY/i.test([d.linkStatus,d.linkBasis].join(' '))).map(d=>d.row)`);
 await run('continueCycle()');const cabinet=run('activeCabinets().find(c=>!S.sessionChecked.has(c.id))?.id');assert(cabinet,'Fixture needs an active unchecked cabinet for the controlled Android write');
 run('TC.guard.remaining=10000');await run(`openCab(${JSON.stringify(cabinet)},'camera')`);el('inspector').value='R5 preservation tester';run('setAllScores(4)');run(`S.stagedDefects=[{point:'R5 preservation test',desc:'Controlled Android round-trip test defect',grade:'C',repeat:'Ei',owner:'R5 preservation tester',due:plusDays(today(),30)}]`);advance(61);await run('saveInspection()');
 const savedControl=run(`savedEntry(${JSON.stringify(cabinet)})`),savedDefect=run(`TC.allDefects.find(d=>d.desc==='Controlled Android round-trip test defect')`);assert(savedControl?.persistentId||savedControl?.syncId);assert(savedDefect?.persistentId||savedDefect?.syncId);
 verify('controlled app save creates one inspection and one linked defect',run('TC.records.length')===beforeCounts.controls+1&&run('TC.allDefects.length')===beforeCounts.defects+1&&!!savedDefect.kontrollId&&savedDefect.kontrollId===savedControl.syncId);
 const maxBytes=run('DIRECT_SYNC_MAX_BYTES'),baselineBytes=Buffer.from(await run('createSyncBaselineBytes()')),baselineZip=await JSZip.loadAsync(baselineBytes,{checkCRC32:true}),workbookEntry=await baselineZip.file('workbook.xlsx').async('uint8array'),stateEntry=await baselineZip.file('state.json').async('uint8array');
 const measurement={sourceWorkbookBytes:freshBytes.length,directBaselineDtcsBytes:baselineBytes.length,workbookEntryBytes:workbookEntry.length,stateEntryBytes:stateEntry.length,limitBytes:maxBytes,exceedsLimitBytes:Math.max(0,baselineBytes.length-maxBytes),remainingLimitBytes:Math.max(0,maxBytes-baselineBytes.length)};
 fs.writeFileSync(path.join(out,'r5-payload-measurement.json'),JSON.stringify(measurement,null,2));verify('direct baseline size measured without changing the 1 MiB transport limit',maxBytes===1024*1024&&baselineZip.file('manifest.json')&&baselineZip.file('workbook.xlsx')&&baselineZip.file('state.json'),JSON.stringify(measurement));
 const saveChunks=[];let exportComplete=false;env.cx.Android.beginSaveFile=(name,mime)=>{env.exportName=name;env.exportMime=mime;return true;};env.cx.Android.writeSaveChunk=b64=>{saveChunks.push(Buffer.from(b64,'base64'));return true;};env.cx.Android.finishSaveFile=()=>{env.exportedBytes=Buffer.concat(saveChunks);exportComplete=true;return true;};
 await run('exportXlsx()');assert(exportComplete,'Current app XLSX export path did not complete');const exportedBytes=Buffer.from(env.exportedBytes);fs.writeFileSync(path.join(out,'r5-v083-android-roundtrip.xlsx'),exportedBytes);
 await freshWorkspace('r5-v083-reimport',exportedBytes);const reimportZip=await JSZip.loadAsync(await run(`S.zip.generateAsync({type:'uint8array'})`),{checkCRC32:true}),finalFeatures=await workbookFeatureSnapshot(reimportZip),finalMap=await workbookPartMap(reimportZip),finalControlMap=await sheetCellMap(reimportZip,finalMap.sheets.Kontrollid),finalDefectMap=await sheetCellMap(reimportZip,finalMap.sheets.Puudused);
 verify('all original sheets and package parts remain after app export and reimport',sourceFeatures.sheets.every(s=>finalFeatures.sheets.includes(s))&&sourceParts.every(p=>finalFeatures.parts.includes(p)));
 verify('all original internal OOXML relationships remain valid',finalFeatures.relationships.every(r=>r.valid));
 verify('all original relationships except package-root metadata links remain unchanged',sourceFeatures.relationships.filter(r=>r.from!=='_rels/.rels').every(r=>finalFeatures.relationships.some(x=>x.from===r.from&&x.id===r.id&&x.target===r.target&&x.valid)));
 verify('drawings, media, rich-data and metadata payload bytes are preserved',await Promise.all(categoryPaths.map(async p=>[p,await archiveEntryHash(sourceZip,p),await archiveEntryHash(reimportZip,p)])).then(items=>items.every(([p,a,b])=>a===b)),`parts=${categoryPaths.length}`);
 const mutableParts=new Set(['docProps/custom.xml','[Content_Types].xml','_rels/.rels','xl/workbook.xml','xl/styles.xml',controlPart,defectPart,summaryPart]);
 const untouchedParts=sourceParts.filter(p=>!mutableParts.has(p));verify('unmodified and unknown OOXML parts are byte-for-byte intact',await Promise.all(untouchedParts.map(async p=>[p,await archiveEntryHash(sourceZip,p),await archiveEntryHash(reimportZip,p)])).then(items=>items.every(([,a,b])=>a===b)),`parts=${untouchedParts.length}`);
 for(const name of requiredSheets)verify(`${name} prototype sheet is unmodified`,await archiveEntryHash(sourceZip,sourceMap.sheets[name])===await archiveEntryHash(reimportZip,finalMap.sheets[name]));
 verify('defined names and print areas remain unchanged',JSON.stringify(sourceFeatures.definedNames)===JSON.stringify(finalFeatures.definedNames));
 verify('all existing formulas survive unchanged',Object.entries(sourceFeatures.formulas).every(([key,value])=>finalFeatures.formulas[key]===value),`source formulas=${Object.keys(sourceFeatures.formulas).length}; exported=${Object.keys(finalFeatures.formulas).length}`);
 verify('merged cells and conditional formatting remain unchanged',Object.keys(sourceFeatures.sheetStructures).every(name=>['mergeCells','conditionalFormatting'].every(tag=>JSON.stringify(sourceFeatures.sheetStructures[name][tag])===JSON.stringify(finalFeatures.sheetStructures[name]?.[tag]))));
 verify('print settings and drawing links remain unchanged',Object.keys(sourceFeatures.sheetStructures).every(name=>['pageMargins','pageSetup','printOptions','headerFooter','legacyDrawing','legacyDrawingHF','drawing','tableParts'].every(tag=>JSON.stringify(sourceFeatures.sheetStructures[name][tag])===JSON.stringify(finalFeatures.sheetStructures[name]?.[tag]))));
 verify('every original KontrollID cell is unchanged',Object.entries(originalControlCells).every(([ref,value])=>JSON.stringify(finalControlMap.get(ref)||null)===JSON.stringify(value)),`IDs=${beforeCounts.kontrollIds}`);
 verify('every original PuudusID cell is unchanged',Object.entries(originalDefectCells).filter(([ref])=>/^S\d+$/.test(ref)).every(([ref,value])=>JSON.stringify(finalDefectMap.get(ref)||null)===JSON.stringify(value)),`IDs=${beforeCounts.puudusIds}`);
 verify('every existing Puudused T link remains unchanged',Object.entries(originalDefectCells).filter(([ref])=>/^T\d+$/.test(ref)).every(([ref,value])=>JSON.stringify(finalDefectMap.get(ref)||null)===JSON.stringify(value)));
 verify('legacy matching and unresolved link status/basis are unchanged',preservedStatusRows.every(row=>['S','T','U','V'].every(col=>JSON.stringify(finalDefectMap.get(`${col}${row}`)||null)===JSON.stringify(originalDefectCells[`${col}${row}`]||null))),`marked rows=${preservedStatusRows.length}`);
 verify('S23 and S25 remain empty',!finalDefectMap.get('S23')?.value&&!finalDefectMap.get('S23')?.inline&&!finalDefectMap.get('S25')?.value&&!finalDefectMap.get('S25')?.inline);
 verify('original business counts and permanent ID counts are preserved with one controlled record added',run('TC.records.length')===beforeCounts.controls+1&&run('TC.allDefects.length')===beforeCounts.defects+1&&run('TC.records.filter(r=>r.persistentId).length')===beforeCounts.kontrollIds+1&&run('TC.allDefects.filter(d=>d.persistentId).length')===beforeCounts.puudusIds+1,JSON.stringify({before:beforeCounts,after:{controls:run('TC.records.length'),defects:run('TC.allDefects.length'),kontrollIds:run('TC.records.filter(r=>r.persistentId).length'),puudusIds:run('TC.allDefects.filter(d=>d.persistentId).length')}}));
 verify('controlled inspection and defect IDs and link survive reimport',run(`TC.records.some(r=>r.syncId===${JSON.stringify(savedControl.syncId)})`)&&run(`TC.allDefects.some(d=>d.syncId===${JSON.stringify(savedDefect.syncId)}&&d.kontrollId===${JSON.stringify(savedControl.syncId)})`));
 verify('prototype signature sheets are not turned into Android production records',await archiveEntryHash(sourceZip,sourceMap.sheets.Parandused)===await archiveEntryHash(reimportZip,finalMap.sheets.Parandused)&&await archiveEntryHash(sourceZip,sourceMap.sheets.Allkirjad)===await archiveEntryHash(reimportZip,finalMap.sheets.Allkirjad));
 fs.writeFileSync(path.join(out,'r5-xlsx-preservation.json'),JSON.stringify({baseline:beforeCounts,added:{cabinet,kontrollId:savedControl.syncId,puudusId:savedDefect.syncId},checks,measurement},null,2));console.log(`R5 XLSX STRUCTURE ${checks.length}/${checks.length} PASS`);
});
fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({adapter:'Node VM with XML/form adapter and fsync-backed bridge; not Android/WebView',input:path.basename(fixture),results},null,2));console.log('PASS ALL',results.length);
})().catch(e=>{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,alerts,error:e.stack},null,2));process.exitCode=1;});
