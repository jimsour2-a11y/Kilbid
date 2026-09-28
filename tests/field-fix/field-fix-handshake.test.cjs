const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const project = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(project, 'app/src/main/assets/DOLD_TechControl_v0.5.3.js'), 'utf8');
const cases = [];

function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Source section missing: ${start}`);
  return source.slice(a, b);
}

const pollSource = section('async function pollDirectHostEvent', '\nfunction hostRequestIsBootstrap');
const controlReaderSource = section('function directControlFromBase64', '\nasync function respondDirectHost');
const commitValidatorSource = section('function validateDirectSyncCommitAck', '\nasync function handleDirectSyncQr');
const hostFlowSource = section('async function showDirectSyncQr', '\nasync function findExistingDirectDatabase');
const prepareSource = section('async function prepareDirectSyncSession', '\nfunction cancelDirectSyncHost');

async function test(name, body) {
  await body();
  cases.push(name);
  console.log('PASS', name);
}

function pollContext(statuses) {
  let index = 0;
  const cx = {
    directHostGeneration: 9,
    Date,
    updateDirectHostCountdown() {},
    Android: {
      getLanSyncSessionStatus() {
        const item = statuses[Math.min(index, statuses.length - 1)];
        index++;
        return JSON.stringify(item);
      }
    },
    setTimeout(resolve) { queueMicrotask(resolve); return 1; },
    clearTimeout() {}
  };
  vm.createContext(cx);
  vm.runInContext(pollSource, cx);
  return {cx, readCount: () => index};
}

function commitValidatorContext() {
  const cx = {
    TextDecoder,
    Uint8Array,
    DIRECT_SYNC_COMMIT_FORMAT: 'DOLD-TECHCONTROL-DIRECT-SYNC-COMMIT',
    bytesToBase64(bytes) { return Buffer.from(bytes).toString('base64'); },
    decode64(text) { return new Uint8Array(Buffer.from(text, 'base64')); }
  };
  vm.createContext(cx);
  vm.runInContext(controlReaderSource, cx);
  vm.runInContext(commitValidatorSource, cx);
  return cx;
}

function validAck(overrides = {}) {
  return {
    format: 'DOLD-TECHCONTROL-DIRECT-SYNC-COMMIT', version: 1, phase: 'SYNC_COMMITTED',
    sessionId: 'session-1', dbId: 'db-1', epoch: 'epoch-1',
    hostDeviceId: 'device-host', clientDeviceId: 'device-client',
    hostDeltaHash: 'host-hash', clientDeltaHash: 'client-hash',
    completedAt: new Date().toISOString(), ...overrides
  };
}

function showContext({prepare, runHost}) {
  const dialogs = [], stopIds = [];
  const cx = {
    TC: {busy: false, dbId: 'db-1'}, S: {zip: new Uint8Array([1])}, directHostGeneration: 0,
    window: null,
    Android: {
      stopLanSyncSessionFor(id) { stopIds.push(id); return true; },
      stopLanSyncSession() { throw new Error('broad stop must not be used for session cleanup'); }
    },
    setBusy(value) { cx.TC.busy = !!value; },
    prepareDirectSyncSession: prepare,
    runDirectSyncHostR4: runHost,
    renderDirectHostWaitScreen() {}, closeDirectStatusScreen() {},
    showDirectDialog: async (title, body) => { dialogs.push({title, body}); return 'done'; },
    showAppChoice: async (title, body) => { dialogs.push({title, body}); return 'done'; },
    directSyncSummaryHtml: () => 'summary', esc: value => String(value),
    renderSyncStatus() {}, directSyncErrorText: () => 'transport error',
    shareSyncBaseline: async () => {}, appDialogChoice() {}, console
  };
  cx.window = cx;
  vm.createContext(cx);
  vm.runInContext(hostFlowSource, cx);
  return {cx, dialogs, stopIds};
}

async function main() {
  await test('01 REQUEST_RECEIVED is surfaced once for one poll', async () => {
    const {cx, readCount} = pollContext([{status:'REQUEST_RECEIVED', requestBase64:'request'}]);
    const event = await cx.pollDirectHostEvent({pairing:{expiresAt:Date.now()+60_000}}, 9);
    assert.equal(event.status, 'REQUEST_RECEIVED');
    assert.equal(readCount(), 1);
  });

  await test('02 RESPONSE_QUEUED prevents stale request replay and polling waits for ACK_RECEIVED', async () => {
    const states = [
      {status:'RESPONSE_QUEUED'}, {status:'WAITING_ACK'},
      {status:'ACK_RECEIVED', requestBase64:'second-request'}
    ];
    const {cx, readCount} = pollContext(states);
    const event = await cx.pollDirectHostEvent({pairing:{expiresAt:Date.now()+60_000}}, 9);
    assert.equal(event.status, 'ACK_RECEIVED');
    assert.equal(event.requestBase64, 'second-request');
    assert.equal(readCount(), 3);
  });

  await test('03 queued terminal response is not mistaken for ACK_RECEIVED; poll waits for COMPLETED', async () => {
    const {cx, readCount} = pollContext([{status:'RESPONSE_QUEUED'}, {status:'COMPLETED'}]);
    const event = await cx.pollDirectHostEvent({pairing:{expiresAt:Date.now()+60_000}}, 9);
    assert.equal(event.status, 'COMPLETED');
    assert.equal(readCount(), 2);
  });

  await test('04 client accepts a matching durable SYNC_COMMITTED acknowledgement', async () => {
    const cx = commitValidatorContext();
    const pairing = {sessionId:'session-1'};
    const expected = {dbId:'db-1', epoch:'epoch-1', hostDeviceId:'device-host', clientDeviceId:'device-client', hostDeltaHash:'host-hash', clientDeltaHash:'client-hash'};
    const bytes = new TextEncoder().encode(JSON.stringify(validAck()));
    assert.equal(cx.validateDirectSyncCommitAck(bytes, pairing, expected).phase, 'SYNC_COMMITTED');
  });

  await test('05 missing final ACK becomes COMMIT_UNCONFIRMED, never success', async () => {
    const cx = commitValidatorContext();
    assert.throws(() => cx.validateDirectSyncCommitAck(new Uint8Array(), {sessionId:'session-1'}, {}), /COMMIT_UNCONFIRMED/);
  });

  await test('06 wrong peer/hash in SYNC_COMMITTED becomes COMMIT_UNCONFIRMED', async () => {
    const cx = commitValidatorContext();
    const bytes = new TextEncoder().encode(JSON.stringify(validAck({clientDeltaHash:'wrong-hash'})));
    const expected = {dbId:'db-1', epoch:'epoch-1', hostDeviceId:'device-host', clientDeviceId:'device-client', hostDeltaHash:'host-hash', clientDeltaHash:'client-hash'};
    assert.throws(() => cx.validateDirectSyncCommitAck(bytes, {sessionId:'session-1'}, expected), /COMMIT_UNCONFIRMED/);
  });

  await test('07 host error displays unconfirmed status and releases its own session', async () => {
    let active = 'host-s1';
    const shown = showContext({
      prepare: async () => ({status:'STARTED', deferred:true, pairing:{sessionId:active}, manifest:{}}),
      runHost: async () => ({status:'ERROR'})
    });
    shown.cx.Android.stopLanSyncSessionFor = id => { shown.stopIds.push(id); if (active === id) active = ''; return true; };
    await shown.cx.showDirectSyncQr();
    assert.equal(active, '');
    assert.deepEqual(shown.stopIds, ['host-s1']);
    assert(shown.dialogs.some(d => d.title === 'SÜNKROONIMISE TULEMUST EI SAANUD KINNITADA'));
    assert(!shown.dialogs.some(d => d.title === 'SÜNKROONITUD'));
  });

  await test('08 new QR starts immediately after unconfirmed sync with new session credentials', async () => {
    let active = '', next = 0;
    const sessionIds = [], tokens = [], stopIds = [], dialogs = [];
    const cx = {
      TC:{busy:false,dbId:'db-1'}, S:{zip:new Uint8Array([1])}, directHostGeneration:0,
      setBusy(v){cx.TC.busy=!!v;},
      prepareDirectSyncSession:async()=>{
        if(active)return {status:'SESSION_ACTIVE'};
        active=`host-${++next}`;sessionIds.push(active);tokens.push(`token-${next}`);
        return {status:'STARTED',deferred:true,pairing:{sessionId:active,token:tokens.at(-1)},manifest:{}};
      },
      runDirectSyncHostR4:async()=>({status:next===1?'ERROR':'COMPLETED'}),
      renderDirectHostWaitScreen(){},closeDirectStatusScreen(){},
      showDirectDialog:async(title,body)=>{dialogs.push({title,body});return 'done';},
      showAppChoice:async(title,body)=>{dialogs.push({title,body});return 'done';},
      directSyncSummaryHtml:()=>'',esc:String,renderSyncStatus(){},directSyncErrorText:()=>'',shareSyncBaseline:async()=>{},appDialogChoice(){},
      Android:{stopLanSyncSessionFor(id){stopIds.push(id);if(active===id)active='';return true;},stopLanSyncSession(){throw Error('broad stop');}}
    };
    cx.window=cx;vm.createContext(cx);vm.runInContext(hostFlowSource,cx);
    await cx.showDirectSyncQr();
    assert.equal(active,'');
    await cx.showDirectSyncQr();
    assert.equal(sessionIds.length,2);
    assert.notEqual(sessionIds[0],sessionIds[1]);
    assert.notEqual(tokens[0],tokens[1]);
    assert.deepEqual(stopIds,['host-1','host-2']);
    assert(dialogs.some(d=>d.title==='SÜNKROONITUD'));
  });

  await test('09 SESSION_ACTIVE from another valid QR is preserved', async () => {
    const shown = showContext({
      prepare: async () => ({status:'SESSION_ACTIVE'}),
      runHost: async () => { throw new Error('must not enter a different session'); }
    });
    await shown.cx.showDirectSyncQr();
    assert.deepEqual(shown.stopIds, []);
    assert(shown.dialogs.some(d => d.title === 'QR-sünkroonimist ei saanud alustada'));
  });

  await test('10 unexpected host-flow exception still releases the matching session', async () => {
    const shown = showContext({
      prepare: async () => ({status:'STARTED', deferred:true, pairing:{sessionId:'host-throw'}, manifest:{}}),
      runHost: async () => { throw new Error('injected protocol exception'); }
    });
    await shown.cx.showDirectSyncQr();
    assert.deepEqual(shown.stopIds, ['host-throw']);
    assert(!shown.dialogs.some(d => d.title === 'SÜNKROONITUD'));
  });

  await test('11 QR-render failure stops only the just-created native session', async () => {
    const pairing = {protocol:1,host:'192.168.1.2',port:34567,sessionId:'created-before-qr-fail',token:'one-time',createdAt:Date.now(),expiresAt:Date.now()+120_000,lineage:'safe'};
    const stopped = [], broadStops = [];
    const cx = {
      S:{zip:new Uint8Array([1])}, TC:{dbId:'db-1',sync:{}}, window:null,
      DIRECT_SYNC_MAX_BYTES:1024,
      createSyncBaselineBytes:async()=>new Uint8Array([1,2,3]),
      supportsR4DirectSync:()=>true,
      bytesToBase64:()=> 'AA==',
      directPairingPayload:()=> 'pairing',
      parseDirectSyncQr:()=>pairing,
      JSZip:{loadAsync:async()=>({file:()=>({async:async()=>JSON.stringify({fileName:'baseline.xlsx'})})})},
      Android:{
        startLanSyncSession:()=>JSON.stringify({ok:true,status:'STARTED',pairing}),
        startLanSyncSessionDeferred:()=>JSON.stringify({ok:true,status:'STARTED',pairing}),
        createLanSyncQrPngBase64:()=>{throw Error('injected QR renderer failure');},
        stopLanSyncSessionFor:id=>{stopped.push(id);return true;},
        stopLanSyncSession:()=>{broadStops.push(true);return true;}
      }
    };
    cx.window=cx;vm.createContext(cx);vm.runInContext(prepareSource,cx);
    await assert.rejects(()=>cx.prepareDirectSyncSession(),/injected QR renderer failure/);
    assert.deepEqual(stopped,['created-before-qr-fail']);
    assert.deepEqual(broadStops,[]);
  });

  console.log(`V0561_JS ${cases.length}/11 PASS`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
