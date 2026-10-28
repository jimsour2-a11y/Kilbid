const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'app/src/main/assets/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app/src/main/assets/DOLD_TechControl_v0.5.3.js'), 'utf8');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS', name); }
  catch (error) { console.error('FAIL', name, '-', error.message); process.exitCode = 1; }
}

const dataSection = html.match(/<section id="dataTab">([\s\S]*?)<\/section>/)?.[1] || '';
const signatureSection = html.match(/<section id="signatureTab"[\s\S]*?<\/section>/)?.[0] || '';
const helperStart = js.indexOf('function signatureDraftUiStatus');
const helperEnd = js.indexOf('function renderSignatureDraftSummary');
const context = {};
vm.createContext(context);
vm.runInContext(js.slice(helperStart, helperEnd), context);
const entries = [
  {draft:{targetType:'Kontroll',kilpId:'EK-052',recordId:'dtc-kontroll-52',signatureId:'dtc-sign-a',signerName:'Mari Maas',captureEndedAtUtcMs:100},state:{label:'Kehtiv (kohalikult kontrollitud)'}},
  {draft:{targetType:'Parandus',kilpId:'EK-029',recordId:'dtc-repair-29',signatureId:'dtc-sign-b',signerName:'Risto K',captureEndedAtUtcMs:300},state:{label:'XLSX-i lisamata'}},
  {draft:{targetType:'Kontroll',kilpId:'EK-003',recordId:'dtc-kontroll-3',signatureId:'dtc-sign-c',signerName:'Janar K',captureEndedAtUtcMs:200},state:{label:'Tühistatud'}}
];

test('top-level Allkirjad tab exists', () => {
  assert.match(html, /id="tabSignature"[^>]*showTab\('signature'\)[^>]*>Allkirjad</);
  assert.match(signatureSection, /ALLKIRJAD JA MUSTANDID/);
});
test('Andmed no longer contains the signature list', () => {
  assert.doesNotMatch(dataSection, /signatureDraftList|ALLKIRJAD JA MUSTANDID/);
});
test('existing Android signature collection is reused once', () => {
  const refreshBody = js.slice(js.indexOf('async function refreshSignatureDrafts'), js.indexOf('async function openCab'));
  assert.strictEqual((refreshBody.match(/Android\.listSignatureDrafts\(\)/g) || []).length, 1);
  assert.match(js, /signatureDraftWorkbookStatus\(draft\)/);
});
test('summary exposes existing signature states', () => {
  assert.match(signatureSection, /signatureDraftSummary/);
  assert.match(js, /Kokku[\s\S]*Kehtiv[\s\S]*Tööfailis lisamata[\s\S]*Tühistatud/);
});
test('Kontroll filter works', () => {
  assert.deepStrictEqual(context.signatureDraftFiltered(entries,{targetType:'Kontroll'}).map(x=>x.draft.signatureId),['dtc-sign-c','dtc-sign-a']);
});
test('Parandus filter works', () => {
  assert.deepStrictEqual(context.signatureDraftFiltered(entries,{targetType:'Parandus'}).map(x=>x.draft.signatureId),['dtc-sign-b']);
});
test('status filter normalizes real workbook labels', () => {
  assert.deepStrictEqual(context.signatureDraftFiltered(entries,{status:'Tööfailis lisamata'}).map(x=>x.draft.signatureId),['dtc-sign-b']);
  assert.strictEqual(context.signatureDraftUiStatus('Kehtiv (kohalikult kontrollitud)'), 'Kehtiv');
});
test('EK search is case-insensitive', () => {
  assert.strictEqual(context.signatureDraftFiltered(entries,{query:'ek-052'}).length,1);
});
test('KontrollID search works', () => {
  assert.strictEqual(context.signatureDraftFiltered(entries,{query:'KONTROLL-52'}).length,1);
});
test('ParandusID search works', () => {
  assert.strictEqual(context.signatureDraftFiltered(entries,{query:'repair-29'}).length,1);
});
test('AllkiriID search works', () => {
  assert.strictEqual(context.signatureDraftFiltered(entries,{query:'SIGN-B'}).length,1);
});
test('signer search works', () => {
  assert.strictEqual(context.signatureDraftFiltered(entries,{query:'risto k'}).length,1);
});
test('newest-first is default and oldest is available', () => {
  assert.deepStrictEqual(context.signatureDraftFiltered(entries,{}).map(x=>x.draft.captureEndedAtUtcMs),[300,200,100]);
  assert.deepStrictEqual(context.signatureDraftFiltered(entries,{sort:'oldest'}).map(x=>x.draft.captureEndedAtUtcMs),[100,200,300]);
});
test('initial rendering is bounded to 50', () => {
  assert.match(js, /SIGNATURE_DRAFT_BATCH_SIZE=50/);
  assert.match(js, /filtered\.slice\(0,signatureDraftVisible\)/);
});
test('NÄITA ROHKEM adds another batch', () => {
  assert.match(signatureSection, /id="signatureLoadMore"[^>]*>NÄITA ROHKEM</);
  assert.match(js, /signatureDraftVisible\+=SIGNATURE_DRAFT_BATCH_SIZE/);
});
test('KINNITA XLSX-I keeps the existing production action', () => {
  assert.match(js, /retryProductionSignature\([^)]*signatureId/);
  assert.match(js, /KINNITA XLSX-I/);
});
test('narrow viewport remains bounded and IDs wrap', () => {
  assert.match(html, /nav\{[^}]*overflow-x:auto/);
  assert.match(html, /@media\(max-width:620px\)[^{]*\{[^}]*signatureFilters\{grid-template-columns:1fr/);
  assert.match(html, /signatureCard[^}]*overflow-wrap:anywhere/);
});
test('light and dark themes share existing color variables', () => {
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /signatureSummary \.card/);
  assert.doesNotMatch(signatureSection, /style="[^"]*(?:color|background):/);
});

if (process.exitCode) process.exit(process.exitCode);
console.log(`Allkirjad UI targeted tests: ${passed}/${passed} PASS`);
