const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '../..');
const javaRoot = path.join(root, 'app/src/main/java/ee/dold/techcontrol');
const dialog = fs.readFileSync(path.join(javaRoot, 'SignatureCaptureDialog.java'), 'utf8');
const pad = fs.readFileSync(path.join(javaRoot, 'SignaturePadView.java'), 'utf8');
const core = fs.readFileSync(path.join(javaRoot, 'SignatureCaptureCore.java'), 'utf8');
const renderer = fs.readFileSync(path.join(javaRoot, 'SignaturePngRenderer.java'), 'utf8');
const store = fs.readFileSync(path.join(javaRoot, 'SignatureDraftStore.java'), 'utf8');
const main = fs.readFileSync(path.join(javaRoot, 'MainActivity.java'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app/src/main/assets/DOLD_TechControl_v0.5.3.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/src/main/assets/index.html'), 'utf8');
let passed = 0;
function check(name, condition) {
  assert(condition, name);
  passed++;
  console.log(`PASS ${name}`);
}

check('capture uses a native Android View and MotionEvent', /class SignaturePadView extends View/.test(pad) && /onTouchEvent\(MotionEvent event\)/.test(pad));
check('capture accepts finger input only', /event\.getToolType\(0\) != MotionEvent\.TOOL_TYPE_FINGER/.test(pad));
check('touch interception is requested through the parent ViewParent', /private void setParentInterceptBlocked\(boolean blocked\)[\s\S]*?getParent\(\)\.requestDisallowInterceptTouchEvent\(blocked\)/.test(pad) && !/\brequestDisallowInterceptTouchEvent\(/.test(pad.replace(/getParent\(\)\.requestDisallowInterceptTouchEvent\(/g, '')) && (pad.match(/setParentInterceptBlocked\(false\)/g) || []).length === 3 && /setParentInterceptBlocked\(true\)/.test(pad));
check('historical touch samples are retained', /getHistorySize\(\)/.test(pad) && /getHistoricalX\(0, i\)/.test(pad) && /getHistoricalY\(0, i\)/.test(pad));
check('ACTION_CANCEL discards the active stroke', /ACTION_CANCEL[\s\S]*?cancelCurrentStroke\(\)/.test(pad) && /void cancelCurrentStroke\(\)/.test(core));
check('touch preview is drawn from normalized raw strokes', /for \(java\.util\.List<SignatureCaptureCore\.Point> stroke/.test(pad) && /canvas\.drawPath\(path, paint\)/.test(pad));
check('capture clear cancels the prior session and creates a fresh one', /private void clearCapture\(\)[\s\S]*?session\.cancelCapture\(\)[\s\S]*?session = newSession\(\)/.test(dialog));
check('dialog cancel does not save and clears current capture data', /private void cancel\(String message\)[\s\S]*?session\.cancelCapture\(\)[\s\S]*?onCaptureCancelled/.test(dialog) && !/private void cancel\(String message\)[\s\S]*?saveDraft/.test(dialog));
check('small screens can scroll header details while actions remain outside that scroller', /ScrollView headerScroll/.test(dialog) && /root\.addView\(headerScroll/.test(dialog) && /root\.addView\(actions/.test(dialog));
check('signature window respects system-bar insets', /setOnApplyWindowInsetsListener/.test(dialog) && /WindowInsets\.Type\.systemBars\(\)/.test(dialog) && /WindowCompat\.setDecorFitsSystemWindows\(window, false\)/.test(dialog));
check('canvas keeps a usable minimum and action controls have touch-sized height', /pad\.setMinimumHeight\(dp\(96\)\)/.test(dialog) && /button\.setMinHeight\(dp\(48\)\)/.test(dialog));
check('required Estonian actions are present', ['TÜHJENDA', 'TAGASI', 'KINNITA'].every(label => dialog.includes(`button("${label}"`)));
check('drafts are saved beneath private app files and listable after restart', /new File\(filesDir, "signature-drafts-s1"\)/.test(store) && /listSignatureDrafts\(\)/.test(main));
check('signature capture is saved locally first and the app owns the later XLSX commit', html.includes('ALLKIRJAD JA MUSTANDID') && html.includes('lisatakse allkirja kirje, tõendus ja pilt aktiivsesse XLSX-i') && dialog.includes('salvestab esmalt telefoni mustandi') && /readSignatureDraft\(String signatureId\)/.test(main) && /commitProductionSignature\(draft\.signatureId\)/.test(js));
check('saved inspection offers the reusable capture target service', /ALLKIRJA MUSTAND/.test(js) && /window\.startDoldSignatureCapture/.test(js) && /window\.startDoldParandusSignatureDraft/.test(js));
check('saved Kontroll post-save capture uses the freshly persisted KontrollID and defers ordinary or next navigation', /const controlId=persistentSyncId\('Kontroll',TC\.cycle\?\.entries\?\.\[c\.id\]\?\.kontrollId\),savedRecord=controlId\?TC\.records\.find\(r=>r\.id===c\.id&&r\.syncId===controlId\):null/.test(js) && /pendingPostSaveSignatureNavigation=\{cabinetId:c\.id,controlId,goNext:!!goNext\};\s*const started=await startKontrollSignatureDraft\(savedRecord\)/.test(js) && /function finishPendingPostSaveSignatureNavigation\(\)[\s\S]*?if\(pending\.goNext\)openNextCabinet\(pending\.cabinetId\);else showTab\('cab'\)/.test(js));
check('save, cancellation, and start-error callbacks all complete deferred post-save navigation', /function onNativeSignatureDraftSaved\([\s\S]*?finishPendingPostSaveSignatureNavigation\(\)/.test(js) && /function onNativeSignatureCaptureCancelled\([\s\S]*?completePostSaveSignatureWithoutDraft/.test(js) && /function onNativeSignatureCaptureError\([\s\S]*?completePostSaveSignatureWithoutDraft/.test(js));
check('native TAGASI/cancel is forwarded to the WebView without changing draft contents', /onCaptureCancelled\(String reason\)[\s\S]*?sendSignatureCaptureCancelled\(reason\)/.test(main) && /private void sendSignatureCaptureCancelled\(String reason\)[\s\S]*?window\.onNativeSignatureCaptureCancelled/.test(main));
check('signature capture dialog writes only the local draft and XLSX append runs in the app transaction', /new SignatureDraftStore\(getFilesDir\(\)\)/.test(main) && /store\.saveDraft\(draft\)/.test(dialog) && !/saveWorkspace|applySyncOperations|Allkirjad|Allkirja_jaljed/.test(dialog) && /skipSemanticJournal:true/.test(js) && /s2AppendProductionSignature/.test(js));
check('new captures use fitted renderer v2 while existing v1 production drafts remain supported', /PROFILE_V1\s*=/.test(renderer) && /PROFILE_V2\s*=/.test(renderer) && /renderFittedCanonical\(points\)/.test(core) && /isSupportedProductionProfile\(draft\.rendererProfile\)/.test(main) && /S2_SIGNATURE_RENDERER_V1/.test(js) && /S2_SIGNATURE_RENDERER_V2/.test(js));

check('Parandus capture uses the approved permanent repair ID and PARANDUSED_L version source', /PARANDUS_VERSION_SOURCE='PARANDUSED_L'/.test(js) && /PARANDUS_RECORD_FORMAT='dold-parandus\/v2'/.test(js) && /window\.startDoldParandusSignatureDraft=startParandusSignatureDraft/.test(js) && /recordVersionSource:PARANDUS_VERSION_SOURCE/.test(js));
check('repair signature snapshot follows the approved Parandused fields and requires resolved permanent PuudusID and KontrollID', /s2BuildParandusRecordSnapshot\(doc,row,recordId,recordVersion,defDoc,controlDoc\)[\s\S]*?performedAtUtcMs,workText,checkedBy:checkedBy\|\|null,workStatus/.test(js) && /persistentSyncId\('Puudus',puudusId\)/.test(js) && /persistentSyncId\('Kontroll',kontrollId\)/.test(js) && /draft\.recordVersionSource!==s2VersionSource\(draft\.targetType\)/.test(js));
check('Parandus capture validates the complete approved sheet contract before opening native capture', /async function startParandusSignatureDraft\(record\)[\s\S]*?if\(!s2ParandusSheetContractReady\(parandusDoc\)\)throw s2SignatureBlock\('SIGNATURE_STRUCTURE_UNSUPPORTED'/.test(js) && /const required=\{A:'ParandusID',B:'EK ID',C:'PuudusID',D:'Teostas',E:'Töö aeg UTC',F:'Tehtud töö',G:'Kontrollis',H:'Töö olek',I:'AllkiriID',J:'Allkirja olek',K:'Allkiri \(TEST\)',L:'Versioon',M:'Test',N:'KontrollID',O:'Täpne UTC'\}/.test(js));
check('repair completion saves the permanent Parandus row before automatically requesting native signature capture', /await transaction\(async\(\)=>\{[\s\S]*?s2AppendParandusRecord\(parandusDoc,repairRecord\)[\s\S]*?\}\);[\s\S]*?const savedRecord=TC\.parandused\.find\(r=>r\.recordId===parandusId\);[\s\S]*?await startParandusSignatureDraft\(parandusId\)/.test(js));
check('Parandus production commit updates only Parandused I/J and preserves Kontrollid AB', /if\(targetType==='Kontroll'\)setInline\(controlDoc,'AB',state\.targetRow,state\.draft\.signatureId\);\s*else\{setInline\(parandusDoc,'I',state\.targetRow,state\.draft\.signatureId\);s2SetFormulaCached\(parandusDoc,'J',state\.targetRow,s2ParandusStatusFormula\(parandusDoc,state\.targetRow\),'Kehtiv','string'\);\}/.test(js) && /targetSignatureStatus!=='Kehtiv'/.test(js));
check('saved unsigned repair remains available for late signing and TAGASI leaves it unsigned', /async function viewParandus\(recordId\)[\s\S]*?await startParandusSignatureDraft\(record\.recordId\)/.test(js) && /function completePostSaveSignatureWithoutDraft\(reason\)[\s\S]*?pendingPostSaveParandusNavigation[\s\S]*?Parandus salvestatud\. Allkiri puudub/.test(js) && /onNativeSignatureCaptureCancelled\(reason\)[\s\S]*?completePostSaveSignatureWithoutDraft/.test(js));

console.log(`S1 UI CONTRACT ${passed}/${passed} PASS`);
