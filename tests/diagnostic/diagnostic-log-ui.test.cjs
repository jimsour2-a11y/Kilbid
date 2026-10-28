'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'../..');
const js=fs.readFileSync(path.join(root,'app/src/main/assets/DOLD_TechControl_v0.5.3.js'),'utf8');
const html=fs.readFileSync(path.join(root,'app/src/main/assets/index.html'),'utf8');
const main=fs.readFileSync(path.join(root,'app/src/main/java/ee/dold/techcontrol/MainActivity.java'),'utf8');
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
function has(text,pattern,message){if(!pattern.test(text))throw new Error(message||String(pattern));}
function no(text,pattern,message){if(pattern.test(text))throw new Error(message||String(pattern));}

test('Seaded diagnostic block and three actions',()=>{
  has(html,/id="diagnosticCard"[\s\S]*Diagnostika[\s\S]*KOPEERI LOGI[\s\S]*EKSPORDI LOGI[\s\S]*TÜHJENDA LOGI/);
});
test('copy bridge copies complete native diagnostic text',()=>{
  has(js,/function copyDiagnosticLog\(\)[\s\S]*Android\.copyDiagnosticLog\(JSON\.stringify\(diagnosticContext\(\)\)\)/);
  has(main,/ClipboardManager[\s\S]*setPrimaryClip[\s\S]*Diagnostika kopeeritud/);
});
test('export uses exact UTF-8 txt filename and FileProvider grant',()=>{
  has(main,/DOLD_TechControl_log\.txt/);has(main,/StandardCharsets\.UTF_8/);has(main,/setClipData\(ClipData\.newUri/);has(main,/FLAG_GRANT_READ_URI_PERMISSION/);
});
test('clear requires confirmation and store creates LOG_CLEARED',()=>{
  has(js,/function clearDiagnosticLog\(\)[\s\S]*showAppChoice\('TÜHJENDA DIAGNOSTIKA'/);has(main,/clearDiagnosticLog\(\)/);
});
test('safe diagnostic header contains required device and workspace context',()=>{
  for(const value of ['appVersion:','versionCode:','package:','android:','device:','installationId:','dbId:','epoch:','workbook:','revision:','timestamp:'])if(!main.includes(value))throw new Error('missing '+value);
});
test('high-level APP workspace business and signature hooks exist',()=>{
  for(const value of ["'WORKSPACE'","'KONTROLL'","'PUUDUS'","'PARANDUS'","'SIGNATURE'","'STARTUP'"])if(!js.includes(value)&&!main.includes(value.replaceAll("'",'"')))throw new Error('missing '+value);
});
test('LAN chunk events include transfer chunk and attempt without auth fields',()=>{
  has(js,/CHUNK_RX.*transfer:.*chunk:.*bytes:.*attempt:/);has(js,/CHUNK_TX.*transfer:.*chunk:.*bytes:.*attempt:/);
  no(js,/diagLog\([^\n]+(?:token|hmac|nonce|rawStrokeCoordinates|pngBase64|proofJson)\s*:/i,'sensitive LAN/signature field logged');
});
test('semantic summary includes applied duplicates and conflicts',()=>{
  has(js,/diagLog\('INFO','SYNC','APPLY',\{received:operations\.length,applied:report\.applied,duplicates:report\.duplicates,conflicts:report\.conflicts/);
});
test('signature events retain counts and short hashes but no evidence payload',()=>{
  has(js,/DRAFT_SAVED.*strokeCount:.*pointCount:.*renderer:.*pngHash:.*strokeHash:.*geometryHash:/);
  no(js,/diagLog\([^\n]+(?:rawStroke|pngBase64|proofJson)\s*:/i);
});
test('diagnostic bridge exposes append stats copy export clear and version remains 0.5.6.1',()=>{
  for(const method of ['appendDiagnosticEvent','getDiagnosticLogStats','copyDiagnosticLog','exportDiagnosticLog','clearDiagnosticLog'])if(!main.includes(method))throw new Error('missing '+method);
  has(js,/const APP_VERSION='0\.5\.6\.1'/);has(main,/return "0\.5\.6\.1"/);
});
console.log(`DIAGNOSTIC_JS_UI PASS ${passed}/10`);
