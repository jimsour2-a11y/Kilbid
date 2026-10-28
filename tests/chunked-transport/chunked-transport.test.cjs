const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const vm=require('vm');

const root=path.resolve(__dirname,'../..');
const controller=fs.readFileSync(path.join(root,'app/src/main/assets/DOLD_TechControl_v0.5.3.js'),'utf8');

function functionSource(name){
  const start=controller.indexOf(`async function ${name}(`)>=0?controller.indexOf(`async function ${name}(`):controller.indexOf(`function ${name}(`);
  if(start<0)throw Error(`Missing production function ${name}`);
  const brace=controller.indexOf('{',start);let depth=0,quote='',escape=false;
  for(let i=brace;i<controller.length;i++){
    const ch=controller[i];
    if(quote){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch===quote)quote='';continue;}
    if(ch==='"'||ch==="'"||ch==='`'){quote=ch;continue;}
    if(ch==='{')depth++;else if(ch==='}'&&--depth===0)return controller.slice(start,i+1);
  }
  throw Error(`Unclosed production function ${name}`);
}

const helperStart=controller.indexOf("const DIRECT_SYNC_QR_PREFIX='DOLD-DIRECT-SYNC/1:'");
const helperEnd=controller.indexOf('function supportsR4DirectSync()',helperStart);
if(helperStart<0||helperEnd<0)throw Error('Chunk transport production block missing');
const source=controller.slice(helperStart,helperEnd)
  +'\n'+functionSource('directClientUploadPackage')
  +'\n'+functionSource('directClientReceivePackage');

let uidCounter=0;
const cx={
  console,Uint8Array,TextEncoder,TextDecoder,Map,Set,JSON,Math,Error,
  uid:()=>String(++uidCounter).padStart(32,'0'),
  digest:async bytes=>crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
  bytesToBase64:bytes=>Buffer.from(bytes).toString('base64'),
  decode64:value=>new Uint8Array(Buffer.from(String(value||''),'base64')),
  directClientExchange:async()=>{throw Error('unexpected native exchange');}
};
vm.createContext(cx);vm.runInContext(source,cx,{filename:'chunked-transport-production.js'});

function data(size,seed=17){const out=new Uint8Array(size);for(let i=0;i<size;i++)out[i]=(i*31+seed)%251;return out;}
function equalBytes(a,b){return Buffer.from(a).equals(Buffer.from(b));}
async function expectReject(fn,code){let error='';try{await fn();}catch(e){error=e.message;}assert.equal(error,code);}

const pairing={sessionId:'abcdefghijklmnopqrstuv',lineage:'a'.repeat(64)};
let passed=0;
async function test(name,body){try{await body();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name,e);process.exitCode=1;}}

(async()=>{
 await test('chunk primitives preserve bytes, bounds, order safety, duplicates and final SHA',async()=>{
   const maximum=data(20*1024*1024,3),maxTransfer=await cx.createDirectPackageTransfer(maximum,'bootstrap',pairing);
   assert.equal(maxTransfer.meta.chunkSize,256*1024);assert.equal(maxTransfer.meta.chunkCount,80);
   assert(cx.directChunkData(maxTransfer,0).length<1024*1024,'one chunk frame exceeded 1 MiB');
   await expectReject(()=>cx.createDirectPackageTransfer(new Uint8Array(20*1024*1024+1),'bootstrap',pairing),'PAYLOAD_TOO_LARGE');

   const bytes=data(700123,9),transfer=await cx.createDirectPackageTransfer(bytes,'client-initial',pairing),assembler=cx.createDirectChunkAssembler(transfer.meta,pairing,'client-initial');
   const second=cx.directChunkMessage(cx.directChunkData(transfer,1));assert.equal(second.chunkCount,transfer.meta.chunkCount,'CHUNK_DATA omitted chunkCount');
   assert.equal(cx.addDirectChunk(assembler,second).duplicate,false,'first out-of-order chunk rejected');
   assert.equal(cx.addDirectChunk(assembler,second).duplicate,true,'exact duplicate was not idempotent');
   await expectReject(()=>cx.assembleDirectChunks(assembler),'CHUNK_MISSING');
   for(let i=0;i<transfer.meta.chunkCount;i++)if(i!==1)cx.addDirectChunk(assembler,cx.directChunkMessage(cx.directChunkData(transfer,i)));
   assert(equalBytes(await cx.assembleDirectChunks(assembler),bytes),'assembled package changed bytes');

   const mismatch=cx.createDirectChunkAssembler(transfer.meta,pairing,'client-initial');
   for(let i=0;i<transfer.meta.chunkCount;i++){
     const message=cx.directChunkMessage(cx.directChunkData(transfer,i));if(i===0){const chunk=cx.decode64(message.data);chunk[0]^=1;message.data=cx.bytesToBase64(chunk);}cx.addDirectChunk(mismatch,message);
   }
   await expectReject(()=>cx.assembleDirectChunks(mismatch),'CHUNK_SHA_MISMATCH');

   const duplicateMismatch=cx.createDirectChunkAssembler(transfer.meta,pairing,'client-initial'),first=cx.directChunkMessage(cx.directChunkData(transfer,0));cx.addDirectChunk(duplicateMismatch,first);
   const changed={...first};const changedBytes=cx.decode64(changed.data);changedBytes[0]^=1;changed.data=cx.bytesToBase64(changedBytes);
   assert.throws(()=>cx.addDirectChunk(duplicateMismatch,changed),/CHUNK_DUPLICATE_MISMATCH/);
 });

 await test('authenticated frame orchestration assembles before semantic import and supports both directions',async()=>{
   const clientPackage=data(2*1024*1024+333,21);let hostAssembler=null,hostAssembled=null,semanticImports=0;
   const uploadExchange=async(_pairing,_db,payload)=>{
     const message=cx.directChunkMessage(payload);assert(message,'non-chunk upload frame');
     if(message.type==='PACKAGE_META'){hostAssembler=cx.createDirectChunkAssembler(message,pairing,'client-initial');return cx.directChunkRequest(message,0);}
     assert.equal(semanticImports,0,'semantic import happened before final assembly');const result=cx.addDirectChunk(hostAssembler,message);
     if(!result.complete)return cx.directChunkRequest(hostAssembler.meta,result.nextIndex);
     hostAssembled=await cx.assembleDirectChunks(hostAssembler);semanticImports++;return new TextEncoder().encode('HOST_DELTA_READY');
   };
   const uploadResult=await cx.directClientUploadPackage(pairing,'db-test',clientPackage,'client-initial',uploadExchange);
   assert.equal(new TextDecoder().decode(uploadResult),'HOST_DELTA_READY');assert.equal(semanticImports,1);assert(equalBytes(hostAssembled,clientPackage));

   const finalPackage=data(1536*1024+19,31);let finalAssembler=null,finalImported=0;
   const finalExchange=async(_pairing,_db,payload)=>{const message=cx.directChunkMessage(payload);if(message.type==='PACKAGE_META'){finalAssembler=cx.createDirectChunkAssembler(message,pairing,'client-final');return cx.directChunkRequest(message,0);}const accepted=cx.addDirectChunk(finalAssembler,message);if(!accepted.complete)return cx.directChunkRequest(finalAssembler.meta,accepted.nextIndex);assert(equalBytes(await cx.assembleDirectChunks(finalAssembler),finalPackage));finalImported++;return new TextEncoder().encode('SYNC_COMMITTED');};
   const finalAck=await cx.directClientUploadPackage(pairing,'db-test',finalPackage,'client-final',finalExchange);assert.equal(new TextDecoder().decode(finalAck),'SYNC_COMMITTED');assert.equal(finalImported,1);

   const hostPackage=data(3*1024*1024+777,44),hostTransfer=await cx.createDirectPackageTransfer(hostPackage,'host-delta',pairing);let requests=0;
   const receiveExchange=async(_pairing,_db,payload)=>{const request=cx.directChunkMessage(payload);assert.equal(request.type,'CHUNK_REQUEST');requests++;return cx.directChunkData(hostTransfer,request.chunkIndex);};
   const received=await cx.directClientReceivePackage(pairing,'db-test',cx.directChunkControl(hostTransfer.meta),'host-delta',receiveExchange);
   assert(equalBytes(received,hostPackage));assert.equal(requests,hostTransfer.meta.chunkCount);

   const baseline=data(4*1024*1024+51,55),baselineTransfer=await cx.createDirectPackageTransfer(baseline,'bootstrap',pairing);
   const bootstrap=await cx.directClientReceivePackage(pairing,'',cx.directChunkControl(baselineTransfer.meta),'bootstrap',async(_pairing,_db,payload)=>{const request=cx.directChunkMessage(payload);return cx.directChunkData(baselineTransfer,request.chunkIndex);});
   assert(equalBytes(bootstrap,baseline),'large bootstrap did not round-trip');

   assert.match(controller,/const WORK_PACKAGE_MIME='application\/zip'/);assert.match(controller,/const SYNC_PACKAGE_MIME='application\/zip'/);
   assert.match(controller,/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/,'XLSX MIME was changed');
 });

 if(process.exitCode)process.exit(process.exitCode);
 console.log(`CHUNKED_TRANSPORT ${passed}/2 PASS`);
})();
