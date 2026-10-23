const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/src/main/assets/index.html'), 'utf8');
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');

function rulesFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...styles.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map(match => match[1]);
}

function declaration(selector, pattern) {
  const found = rulesFor(selector).join(';');
  assert(pattern.test(found), `${selector} must include ${pattern}`);
}

const checks = [];
function verify(name, fn) {
  fn();
  checks.push(name);
  console.log('PASS', name);
}

verify('app dialogs respect Android top and bottom safe areas', () => {
  const overlay = rulesFor('.appdialog').join(';');
  assert(overlay.includes('position:fixed') && overlay.includes('inset:0'));
  assert(overlay.includes('safe-area-inset-top') && overlay.includes('safe-area-inset-bottom'));
});

verify('dialog card is constrained by viewport height with legacy and dynamic viewport rules', () => {
  const card = rulesFor('.app-dialog-card').join(';');
  assert(card.includes('max-height:min(85vh,calc(100vh'));
  assert(card.includes('safe-area-inset-top') && card.includes('safe-area-inset-bottom'));
  assert(styles.includes('@supports (height:100dvh)'));
  assert(rulesFor('.app-dialog-card').some(rule => rule.includes('100dvh')));
});

verify('dialog card keeps a column layout and contains overflow', () => {
  declaration('.app-dialog-card', /display:flex/);
  declaration('.app-dialog-card', /flex-direction:column/);
  declaration('.app-dialog-card', /overflow:hidden/);
  declaration('.app-dialog-card', /min-height:0/);
});

verify('dialog title remains outside the scrolling body', () => {
  const cardStart = html.indexOf('class="card app-dialog-card"');
  const title = html.indexOf('id="appDialogTitle"', cardStart);
  const body = html.indexOf('id="appDialogBody"', title);
  const actions = html.indexOf('id="appDialogActions"', body);
  assert(cardStart >= 0 && title > cardStart && body > title && actions > body);
  assert(/id="appDialogBody"[^>]*><\/div>\s*<div id="appDialogActions"/.test(html));
  declaration('.app-dialog-header', /flex:0 0 auto/);
});

verify('long dialog body is the independently scrollable region', () => {
  declaration('.app-dialog-body', /overflow-y:auto/);
  declaration('.app-dialog-body', /flex:1 1 auto/);
  declaration('.app-dialog-body', /min-height:0/);
});

verify('action footer stays outside body overflow and remains reachable', () => {
  declaration('.app-dialog-actions', /flex:0 0 auto/);
  declaration('.app-dialog-actions', /overflow-y:auto/);
  assert(rulesFor('.app-dialog-actions').join(';').includes('max-height:30vh'));
  assert(rulesFor('.app-dialog-actions').join(';').includes('max-height:30dvh'));
  assert(/id="appDialogBody"[^>]*><\/div>\s*<div id="appDialogActions"/.test(html));
});

verify('desktop dialog width remains capped at the previous 560px layout', () => {
  declaration('.app-dialog-card', /width:min\(560px,100%\)/);
});

verify('choice and direct-status dialogs share the responsive shell', () => {
  const controller = fs.readFileSync(path.join(root, 'app/src/main/assets/DOLD_TechControl_v0.5.3.js'), 'utf8');
  assert(controller.includes("$('appDialogTitle').textContent=title;$('appDialogBody').innerHTML=body;"));
  assert(controller.includes("$('appDialogActions').innerHTML=actions.map"));
  assert(controller.includes("$('appDialogTitle').textContent='TELEFONIDE SÜNKROONIMINE'"));
});

console.log(`R5 RESPONSIVE MODAL ${checks.length}/${checks.length} PASS`);
