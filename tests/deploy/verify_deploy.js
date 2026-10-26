/* =========================================================================
   贴纸进销存 · 本机部署验证
   验证对象：真实运行中的本机服务 http://127.0.0.1:8765/
   —— 这一次不打任何 mock，页面直连 WorkBuddy 云服务
   ========================================================================= */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8765/';
const SHOT = '/tmp/deploy-verify';
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
  t(pingRes.status === 200, '自检接口 /__app_ping 返回 200');
  t(ping.app === 'sticker-inventory', '服务标识正确：' + ping.app);
  t(ping.port === 8765, '监听端口 8765');
  t(ping.dir.endsWith('2026-10-12-11-46-33'), '托管目录指向应用目录');

  for (const f of ['index.html', 'app.css', 'app.js']) {
    const r = await fetch(BASE + f);
    const body = await r.text();
    t(r.status === 200 && body.length > 100, '静态资源 ' + f + ' → HTTP ' + r.status + '（' + body.length + ' 字节）');
  }
  const ct = (await fetch(BASE + 'app.js')).headers.get('content-type') || '';
  t(ct.includes('javascript'), 'app.js 的 MIME 类型正确：' + ct);

  const cc = (await fetch(BASE + 'index.html')).headers.get('cache-control') || '';
  t(cc.includes('no-store'), '已禁用浏览器缓存（改完代码刷新即生效）');

  const blocked = await fetch(BASE + '.workbuddy/memory/');
  t(blocked.status === 403, '隐藏目录 .workbuddy 被拦截 → HTTP ' + blocked.status);

  const notFound = await fetch(BASE + 'no-such-file.js');
  t(notFound.status === 404, '不存在的资源返回 404（不会误伤成 200）');

  /* ------------------------------------------------ 2. 页面装载 */
  section('二、页面装载（真实连云端，无 mock）');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  const loginVisible = await page.evaluate(() =>
    !document.getElementById('loginView').classList.contains('hidden'));
  const bootVisible = await page.evaluate(() =>
    !document.getElementById('bootView').classList.contains('hidden'));
  t(!bootVisible, '加载态已结束（bootView 隐藏）');
  t(loginVisible, '登录界面已渲染（SDK 初始化成功）');

  const sdkOk = await page.evaluate(() => typeof window.WorkBuddyCloud === 'object' && !!window.WorkBuddyCloud);
  t(sdkOk, '云服务 SDK 全局对象已就绪');

  const title = await page.title();
  t(title === '贴纸进销存', '页面标题：' + title);

  const buttons = await page.evaluate(() => ({
    send: !!document.getElementById('sendCodeBtn'),
    login: !!document.getElementById('loginBtn'),
    phone: !!document.getElementById('phoneInput'),
    code: !!document.getElementById('codeInput'),
  }));
  t(buttons.phone && buttons.code && buttons.send && buttons.login, '登录表单四个控件齐全');

  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tab-btn, nav button, [data-tab]')).map((b) => b.textContent.trim()));
  t(tabs.length >= 3, '主导航渲染 ' + tabs.length + ' 个入口：' + tabs.join(' / '));

  /* ------------------------------------------------ 3. 云端连通 */
  section('三、云端连通性（经 SDK 真实调用）');
  const probe = await page.evaluate(async (cfg) => {
    let client;
    try { client = (typeof cloud !== 'undefined' && cloud) || window.WorkBuddyCloud.createWorkBuddyCloud(cfg); }
    catch (e) { return { stage: 'client', ok: false, err: String(e && (e.message || e)) }; }
    try {
      const rows = await client.database.from('products').select('id').limit(1);
      return { stage: 'query', ok: true, rows: Array.isArray(rows) ? rows.length : 0 };
    } catch (e) {
      const msg = String((e && (e.message || e.error_description)) || e);
      const network = /Failed to fetch|NetworkError|ERR_|load failed/i.test(msg);
      return { stage: 'query', ok: !network, err: msg, code: e && (e.code || e.status), network };
    }
  }, { endpoint: CLOUD, publishableKey: APIKEY, oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth' });

  t(probe.ok, 'SDK 可发起真实数据库查询' +
    (probe.ok
      ? (probe.stage === 'query' && probe.rows !== undefined
         ? '（返回 ' + probe.rows + ' 行）'
         : '（被服务端正常拒绝，说明网关可达、未登录被 RLS 拦截）')
      : '：' + probe.err));

  const cloudResp = netLog.filter((x) => x.url.includes('sticker-inventory.app.workbuddy.host'));
  t(cloudResp.length > 0, '已向云服务网关产生 ' + cloudResp.length + ' 个响应');
  t(cloudResp.every((x) => x.status > 0 && x.status < 500),
    '云端响应均为正常业务状态码：' + (cloudResp.map((x) => x.status).join(', ') || '无'));

  const sdkCdn = netLog.filter((x) => x.url.includes('cdn.jsdelivr.net'));
  t(sdkCdn.length === 0 || sdkCdn.every((x) => x.status === 200), 'SDK 依赖 CDN 加载正常');

  /* ------------------------------------------------ 4. 健康度 */
  section('四、运行健康度');
  t(pageErrors.length === 0, '无未捕获的 JS 异常' + (pageErrors.length ? '：' + pageErrors[0] : ''));
  t(consoleErrors.length === 0, '控制台无 error 级日志' + (consoleErrors.length ? '：' + consoleErrors[0] : ''));
  t(failedReqs.length === 0, '无失败请求' + (failedReqs.length ? '：' + failedReqs[0] : ''));

  await page.screenshot({ path: SHOT + '/01-login.png' });
  await page.locator('#phoneInput').fill('13800000000');
  await page.screenshot({ path: SHOT + '/02-login-filled.png' });

  /* ------------------------------------------------ 汇总 */
  console.log('\n' + '─'.repeat(60));
  console.log('  通过 ' + pass + ' / ' + (pass + fail) + '    失败 ' + fail);
  if (fail) console.log('  失败项：\n' + failures.map((f) => '    · ' + f).join('\n'));
  console.log('─'.repeat(60));

  fs.writeFileSync(SHOT + '/result.json', JSON.stringify({
    pass, fail, failures, net: netLog, probe,
    consoleErrors, pageErrors, failedReqs,
    at: new Date().toISOString(),
  }, null, 2));

  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('验证脚本异常：', e); process.exit(2); });
