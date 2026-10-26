/* 静态完整性校验：页面三件套、事件处理器、组件引用（node scripts/static-check.js） */
const fs = require('fs');
const p = require('path');
const app = JSON.parse(fs.readFileSync('app.json', 'utf8'));
const err = [];
for (const pg of app.pages) {
  for (const ext of ['js', 'wxml', 'json']) {
    if (!fs.existsSync(pg + '.' + ext)) err.push('MISSING ' + pg + '.' + ext);
  }
  const src = fs.readFileSync(pg + '.js', 'utf8');
  const wxml = fs.readFileSync(pg + '.wxml', 'utf8');
  const hs = new Set();
  for (const m of wxml.matchAll(/bind(?:tap|input|change|confirm|blur|submit|longpress|focus|danger|cancel)="([A-Za-z0-9_]+)"/g)) hs.add(m[1]);
  for (const h of hs) {
    if (!new RegExp('\\b' + h + '\\s*\\(').test(src)) err.push('HANDLER_MISSING ' + pg + ' -> ' + h);
  }
}
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const fp = p.join(d, f);
    const st = fs.statSync(fp);
    if (st.isDirectory()) {
      if (f !== 'node_modules' && f !== 'miniprogram_npm') walk(fp);
    } else if (f.endsWith('.json')) {
      try {
        const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (j.usingComponents) {
          for (const [, v] of Object.entries(j.usingComponents)) {
            const base = v.startsWith('/') ? p.join('.', v) : p.join(p.dirname(fp), v);
            if (!fs.existsSync(base + '.js')) err.push('COMP_MISSING ' + fp + ' -> ' + v);
          }
        }
      } catch (e) { /* 忽略非组件 json */ }
    }
  }
}
walk('.');
console.log(err.length ? 'ERRORS:\n' + err.join('\n') : 'ALL_STATIC_CHECKS_PASS');
