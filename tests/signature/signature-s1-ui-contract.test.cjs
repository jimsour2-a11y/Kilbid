const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '../..');
const javaRoot = path.join(root, 'app/src/main/java/ee/dold/techcontrol');
const dialog = fs.readFileSync(path.join(javaRoot, 'SignatureCaptureDialog.java'), 'utf8');
const pad = fs.readFileSync(path.join(javaRoot, 'SignaturePadView.java'), 'utf8');
const core = fs.readFileSync(path.join(javaRoot, 'SignatureCaptureCore.java'), 'utf8');
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
check('signature flow is visibly labeled local draft and does not claim XLSX validity', html.includes('ALLKIRJA MUSTANDID (S1)') && html.includes('ega märgi allkirja kehtivaks') && dialog.includes('XLSX-i allkirja ei lisata'));
check('saved inspection offers the reusable capture target service', /ALLKIRJA MUSTAND/.test(js) && /window\.startDoldSignatureCapture/.test(js) && /window\.startDoldParandusSignatureDraft/.test(js));
check('signature native bridge is isolated from workbook mutation calls', /new SignatureDraftStore\(getFilesDir\(\)\)/.test(main) && /store\.saveDraft\(draft\)/.test(dialog) && !/saveWorkspace|applySyncOperations|Allkirjad|Allkirja_jaljed/.test(dialog));

console.log(`S1 UI CONTRACT ${passed}/${passed} PASS`);
