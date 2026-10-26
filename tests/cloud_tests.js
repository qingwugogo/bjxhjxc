/* =========================================================================
   贴纸进销存 · 集成测试（integration tests）
   对象：本机服务 http://127.0.0.1:8765 + WorkBuddy 云服务（真实环境，无 mock）
   覆盖：服务层 / 页面装载 / SDK 云端连通 / 未登录 RLS 拦截 / 运行健康度
   数据层一致性由 tests/gen_expected.py + SQL 交叉验证另行核对。
   运行：NODE_PATH=<node_modules> node tests/cloud_tests.js
   ========================================================================= */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8765/';
const SHOT = '/tmp/mock/cloud-shots';
fs.mkdirSync(SHOT, { recursive: true });

const APIKEY = 'wbpk_O8jLJIabPTnWmTRC3CxhH7_aQfiCNsk2b65HK6ofU0v1YT6M2cdfgdW';
const CLOUD = 'https://sticker-inventory.app.workbuddy.host';

let pass = 0, fail = 0;
const failures = [];
function t(cond, msg) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; failures.push(msg); console.log('  \x1b[31m✗\x1b[0m ' + msg); }
}
function section(title) { console.log('\n\x1b[1m' + title + '\x1b[0m'); }

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 920 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedReqs = [];
  const netLog = [];

  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('requestfailed', (r) => failedReqs.push(r.url() + '  ::  ' + (r.failure() || {}).errorText));
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith('http://127.0.0.1:8765') || u.includes('sticker-inventory.app.workbuddy.host') ||
        u.includes('cdn.jsdelivr.net')) {
      netLog.push({ url: u.replace('https://', ''), status: r.status() });
    }
  });

  /* ------------------------------------------------ 1. 服务层 */
  section('一、本机服务');
  const pingRes = await fetch('http://127.0.0.1:8765/__app_ping');
  const ping = await pingRes.json();
  t(pingRes.status === 200, 'I1.1 自检接口 /__app_ping 返回 200');
  t(ping.app === 'sticker-inventory', 'I1.2 服务标识正确：' + ping.app);
  t(ping.port === 8765, 'I1.3 监听端口 8765');

  for (const f of ['index.html', 'app.css', 'app.js']) {
    const r = await fetch(BASE + f);
    const body = await r.text();
    t(r.status === 200 && body.length > 100, 'I1.4 静态资源 ' + f + ' → HTTP ' + r.status + '（' + body.length + ' 字节）');
  }
  const ct = (await fetch(BASE + 'app.js')).headers.get('content-type') || '';
  t(ct.includes('javascript'), 'I1.5 app.js 的 MIME 类型正确');
  const cc = (await fetch(BASE + 'index.html')).headers.get('cache-control') || '';
  t(cc.includes('no-store'), 'I1.6 已禁用浏览器缓存（改完代码刷新即生效）');
  t((await fetch(BASE + '.workbuddy/memory/')).status === 403, 'I1.7 隐藏目录 .workbuddy 被拦截');
  t((await fetch(BASE + 'no-such-file.js')).status === 404, 'I1.8 不存在的资源返回 404');

  /* ------------------------------------------------ 2. 页面装载（真实连云） */
  section('二、页面装载（真实云端，无 mock）');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  const loginVisible = await page.evaluate(() =>
    !document.getElementById('loginView').classList.contains('hidden'));
  const bootVisible = await page.evaluate(() =>
    !document.getElementById('bootView').classList.contains('hidden'));
  t(!bootVisible, 'I2.1 加载态已结束（bootView 隐藏）');
  t(loginVisible, 'I2.2 未登录时登录界面已渲染（SDK 初始化成功）');
  t(await page.evaluate(() => typeof window.WorkBuddyCloud === 'object' && !!window.WorkBuddyCloud),
    'I2.3 云服务 SDK 全局对象已就绪');
  t((await page.title()) === '贴纸进销存', 'I2.4 页面标题：贴纸进销存');
  const ui = await page.evaluate(() => ({
    send: !!document.getElementById('sendCodeBtn'),
    login: !!document.getElementById('loginBtn'),
    phone: !!document.getElementById('phoneInput'),
    code: !!document.getElementById('codeInput'),
    rate: !!document.getElementById('rateBtn'),
    tabs: document.querySelectorAll('[data-tab]').length,
  }));
  t(ui.phone && ui.code && ui.send && ui.login, 'I2.5 登录表单四个控件齐全');
  t(ui.rate, 'I2.6 顶栏汇率按钮已渲染');
  t(ui.tabs >= 5, 'I2.7 主导航渲染 ' + ui.tabs + ' 个页签（建档/库存/流水/订单/报表）');

  /* ------------------------------------------------ 3. 云端连通 + RLS */
  section('三、云端连通性与 RLS（经 SDK 真实调用）');
  const probe = await page.evaluate(async (cfg) => {
    const client = window.WorkBuddyCloud.createWorkBuddyCloud(cfg);
    const out = {};
    try {
      const r = await client.database.from('products').select('id').limit(1);
      out.select = { blocked: !!(r && r.error), code: r && r.error && (r.error.code || r.error.status), rows: Array.isArray(r.data) ? r.data.length : null };
    } catch (e) { out.select = { blocked: true, code: String((e && (e.code || e.status)) || e.message || e) }; }
    try {
      const r = await client.database.from('products').insert({ code: 'X', name: 'X', stock: 0 });
      out.insert = { blocked: !!(r && r.error), code: r && r.error && (r.error.code || r.error.status) };
    } catch (e) { out.insert = { blocked: true, code: String((e && (e.code || e.status)) || e.message || e) }; }
    return out;
  }, { endpoint: CLOUD, publishableKey: APIKEY, oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth' });

  t(probe.select.rows === 0, 'I3.1 未登录 SELECT 被 RLS 过滤为 0 行，数据不泄露（' + JSON.stringify(probe.select) + '）');
  t(probe.insert.blocked !== false, 'I3.2 未登录 INSERT 被 RLS 拦截（' + JSON.stringify(probe.insert) + '）');

  const cloudResp = netLog.filter((x) => x.url.includes('sticker-inventory.app.workbuddy.host'));
  t(cloudResp.length > 0, 'I3.3 已向云服务网关产生 ' + cloudResp.length + ' 个响应');
  t(cloudResp.every((x) => x.status > 0 && x.status < 500),
    'I3.4 云端响应均为正常业务状态码：' + (cloudResp.map((x) => x.status).join(', ') || '无'));

  /* ------------------------------------------------ 4. 健康度 */
  section('四、运行健康度');
  t(pageErrors.length === 0, 'I4.1 无未捕获的 JS 异常' + (pageErrors.length ? '：' + pageErrors[0] : ''));
  /* 401 的资源加载提示来自 I3.2 的未登录写入探测，属预期表现 */
  const unexpectedConsole = consoleErrors.filter((m) => !/status of 401/.test(m));
  t(unexpectedConsole.length === 0, 'I4.2 控制台无预期外的 error 级日志' +
    (unexpectedConsole.length ? '：' + unexpectedConsole[0] : '（仅 1 条 RLS 探测产生的 401，属预期）'));
  t(failedReqs.length === 0, 'I4.3 无失败请求' + (failedReqs.length ? '：' + failedReqs[0] : ''));

  await page.screenshot({ path: SHOT + '/login.png' });

  console.log('\n' + '─'.repeat(60));
  console.log('  集成测试通过 ' + pass + ' / ' + (pass + fail) + '    失败 ' + fail);
  if (fail) console.log('  失败项：\n' + failures.map((f) => '    · ' + f).join('\n'));
  console.log('─'.repeat(60));

  fs.writeFileSync('/tmp/mock/cloud-result.json', JSON.stringify({
    pass, fail, failures, probe, consoleErrors, pageErrors, failedReqs,
    at: new Date().toISOString(),
  }, null, 2));

  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('集成测试异常：', e); process.exit(2); });
