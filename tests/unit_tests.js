/* =========================================================================
   贴纸进销存 · 单元测试（unit tests）
   对象：app.js 里的纯函数 / 聚合函数，逐个喂构造输入、断言输出。
   与 run_tests.js（端到端功能测试）互补：这里测「函数级」的正确性，
   不走界面点击，跑得快、定位准。
   运行：NODE_PATH=<node_modules> node tests/unit_tests.js
   ========================================================================= */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8765/';

/* 最小化云 SDK mock：够 app.js 完成启动、不抛异常即可（单元测试不打数据库） */
const INSTALL_SRC = `
window.__installMockCloud = function () {
  var empty = { data: [], error: null };
  function Q() { this.mode = 'select'; this.sel = '*'; this.singleMode = null; }
  Q.prototype.select = function () { return this; };
  ['eq','neq','ilike','gte','lte','lt','order','limit'].forEach(function (m) {
    Q.prototype[m] = function () { return this; };
  });
  Q.prototype.maybeSingle = function () { this.singleMode = 'maybe'; return this; };
  Q.prototype.single = function () { this.singleMode = 'one'; return this; };
  Q.prototype.insert = function () { return this; };
  Q.prototype.update = function () { return this; };
  Q.prototype.then = function (ok) { return ok(this.singleMode ? { data: null, error: null } : empty); };
  cloud.database.from = function () { return new Q(); };
  cloud.auth.getSession = function () {
    return Promise.resolve({ data: null, error: null });
  };
  cloud.auth.signOut = function () { return Promise.resolve({ error: null }); };
  cloud.storage.userPath = function (uid, p) { return uid + '/' + p; };
  cloud.storage.upload = function () { return Promise.resolve({ data: { path: 'x' }, error: null }); };
  cloud.storage.createSignedUrls = function () { return Promise.resolve({ data: [], error: null }); };
  cloud.llm.models = { list: function () { return Promise.resolve([]); } };
  return true;
};
`;

let pass = 0, fail = 0;
const failures = [];
function t(cond, msg) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; failures.push(msg); console.log('  \x1b[31m✗\x1b[0m ' + msg); }
}
function section(title) { console.log('\n\x1b[1m' + title + '\x1b[0m'); }
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 0.005 : eps);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 880 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.addInitScript({ content: INSTALL_SRC });
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1200);

  const R = await page.evaluate(() => {
    const ok = [];
    const bad = [];
    const t = (cond, msg) => (cond ? ok : bad).push(msg);
    const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 0.005 : eps);
    const today = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const nowIso = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12).toISOString();

    /* ================= U1 基础工具函数 ================= */
    t(esc('<b "x" & \'y\'>') === '&lt;b &quot;x&quot; &amp; &#39;y&#39;&gt;',
      'U1.1 esc 转义 < > " \' &（单趟替换不二次转义）');
    t(esc(null) === '' && esc(undefined) === '', 'U1.2 esc(null/undefined) → 空串');
    t(toNum('3.5') === 3.5 && toNum(' 4 ') === 4, 'U1.3 toNum 解析数字字符串');
    t(toNum('abc') === 0 && toNum(-5) === 0 && toNum(Infinity) === 0,
      'U1.4 toNum 对非数字 / 负数 / 无穷一律归 0');
    t(fmtUsd(6.99) === '$6.99' && fmtUsd(0) === '$0.00' && fmtUsd(NaN) === '$0.00',
      'U1.5 fmtUsd 美元两位小数，非法值归 $0.00');
    t(moneyOrDash(null) === '<span class="dash">未填</span>' &&
      moneyOrDash('') === '<span class="dash">未填</span>' &&
      moneyOrDash(3.5).indexOf('¥3.50') >= 0,
      'U1.6 moneyOrDash 空值显示「未填」，非空显示 ¥ 金额');
    t(usdOrDash(null).indexOf('未填') >= 0 && usdOrDash(6.99) === '$6.99',
      'U1.7 usdOrDash 同上（美元符号）');
    t(fmtTimeOrDash('') === '<span class="dash">—</span>' &&
      fmtTimeOrDash('not-a-date') === '<span class="dash">—</span>',
      'U1.8 fmtTimeOrDash 缺失 / 非法时间显示「—」');
    t(fmtTimeOrDash('2026-10-16T09:30:00Z').indexOf('2026-10-16') >= 0,
      'U1.9 fmtTimeOrDash 正常时间格式化成年月日时分');
    t(maskPhone('13812345678') === '138****5678' && maskPhone('123') === '123',
      'U1.10 maskPhone 11 位手机号打码，短号原样返回');

    /* ================= U2 汇率 ================= */
    usdCnyRate = 7.2;
    t(rateOf() === 7.2 && fmtRate() === '7.20', 'U2.1 汇率默认 7.2，格式化两位小数');
    usdCnyRate = 0; t(rateOf() === 7.2, 'U2.2 汇率为 0 时回退默认 7.2（防除零）');
    usdCnyRate = -3; t(rateOf() === 7.2, 'U2.3 汇率为负时回退默认 7.2');
    usdCnyRate = 7.55;
    t(rateOf() === 7.55 && fmtRate() === '7.55', 'U2.4 可设置任意正汇率（如 7.55）');
    usdCnyRate = 'abc';
    t(rateOf() === 7.2, 'U2.5 汇率为非法字符串时回退默认 7.2');
    usdCnyRate = 7.2;

    /* ================= U3 AI 识别结果解析 ================= */
    t(parseModelJson('{"name":"星空贴纸"}').name === '星空贴纸',
      'U3.1 parseModelJson 解析裸 JSON');
    t(parseModelJson('```json\\n{"name":"A"}\\n```').name === 'A',
      'U3.2 parseModelJson 剥掉 markdown 代码围栏');
    t(parseModelJson('识别结果如下：{"name":"B","origin":""}').name === 'B' &&
      parseModelJson('识别结果如下：{"name":"B"}').origin === '',
      'U3.3 parseModelJson 从混杂文本里截取 JSON，缺失字段归空串');
    t(parseModelJson('完全不是 JSON').name === '' &&
      parseModelJson('').name === '' && parseModelJson(null).name === '',
      'U3.4 parseModelJson 对垃圾输入返回全空对象（不抛异常）');
    t(parseModelJson('{"name":123,"brand":null}').name === '' &&
      parseModelJson('{"name":123,"brand":null}').brand === '',
      'U3.5 parseModelJson 只收字符串字段，数字 / null 归空串');

    /* ================= U4 品牌聚合 ================= */
    inventoryCache = [
      { brand: '纸间集', stock: 5 },
      { brand: '纸间集', stock: 3 },
      { brand: 'MoonBerry', stock: 1 },
      { brand: '', stock: 9 },
      { brand: null, stock: 2 },
    ];
    const bs = buildBrandStats();
    t(bs.length === 3, 'U4.1 品牌聚合：3 个分组（2 品牌 + 未标注）');
    const mb = bs.filter((s) => s.name === 'MoonBerry')[0];
    const zjj = bs.filter((s) => s.name === '纸间集')[0];
    t(!!mb && mb.count === 1 && mb.stock === 1, 'U4.2 分组内商品数与库存合计正确');
    t(bs[bs.length - 1].key === '__none__' && bs[bs.length - 1].stock === 11,
      'U4.3 未标注品牌固定排最后，库存 9+2=11');
    t(!!zjj && zjj.count === 2 && zjj.stock === 8, 'U4.4 同名品牌合并计数');
    t(bs[0].key !== '__none__' &&
      bs.filter((s) => s.key !== '__none__').map((s) => s.name).join() ===
      bs.filter((s) => s.key !== '__none__').map((s) => s.name)
        .sort((a, b) => a.localeCompare(b, 'zh-CN')).join(),
      'U4.5 品牌组按名称排序（zh-CN，未标注组置底不参与）');

    /* ================= U5 订单聚合（含退货冲减 / 汇率换算） ================= */
    orderCosts = new Map([['TK-A', { other_cost: 5, cost_note: '运费' }]]);
    const prod = { id: 'p1', name: '星空贴纸', code: 'SP001', cost_price: 3 };
    const rows = [
      // 出库 2 件 × $10 → $20，成本 2×¥3
      { order_no: 'TK-A', move_type: 'out', quantity: 2, unit_price: 10, buyer_name: 'Amy', created_at: nowIso, product: prod, product_id: 'p1' },
      // 退货 1 件 → 冲减 $10 与 ¥3
      { order_no: 'TK-A', move_type: 'in', is_return: true, quantity: 1, unit_price: 10, created_at: nowIso, product: prod, product_id: 'p1' },
      // 普通补货入库：不计入订单
      { order_no: 'TK-A', move_type: 'in', quantity: 5, unit_price: 3, created_at: nowIso, product: prod, product_id: 'p1' },
      // 无订单号：不计入任何订单
      { order_no: '', move_type: 'out', quantity: 9, unit_price: 9, created_at: nowIso, product: prod, product_id: 'p1' },
    ];
    const st = buildOrderStats(rows, '');
    t(st.list.length === 1, 'U5.1 普通补货入库与无订单号出库不计入订单聚合');
    const a = st.list[0];
    t(a.moves === 1 && a.returnMoves === 1 && a.qty === 1 && a.returnQty === 1,
      'U5.2 出库 1 笔 / 退货单记 1 笔，净件数 2−1=1（补货不算）');
    t(near(a.salesUsd, 10) && near(a.sales, 10 * 7.2),
      'U5.3 净销售额 $10（$20 − 退货 $10），按汇率折 ¥72');
    t(near(a.cost, 3) && near(a.net, 72 - 3 - 5),
      'U5.4 净成本 ¥3、减其他成本 ¥5 后净利 ¥64');
    t(a.buyer === 'Amy' && a.lastBuyer === 'Amy', 'U5.5 客户姓名取第一条非空值');
    t(a.products.length === 1 && a.products[0][1] === 1,
      'U5.6 商品行按「出库 − 退货」净数量展示（2 − 1 = 1）');
    t(st.total.orders === 1 && near(st.total.net, 64), 'U5.7 合计口径与单订单一致');
    const stKw = buildOrderStats(rows, 'tk-');
    t(stKw.list.length === 1, 'U5.8 订单号关键字大小写不敏感');
    const stNone = buildOrderStats(rows, 'no-such');
    t(stNone.list.length === 0 && stNone.total.orders === 0, 'U5.9 关键字无命中返回空列表');
    // 退货多于出库的脏数据：净额兜底为 0，不为负
    const dirty = buildOrderStats([
      { order_no: 'TK-B', move_type: 'out', quantity: 1, unit_price: 10, created_at: nowIso, product: prod, product_id: 'p1' },
      { order_no: 'TK-B', move_type: 'in', is_return: true, quantity: 3, unit_price: 10, created_at: nowIso, product: prod, product_id: 'p1' },
    ], '');
    t(dirty.list[0].salesUsd === 0 && dirty.list[0].cost === 0 && dirty.list[0].net === 0,
      'U5.10 退货多于出库的历史脏数据，净额兜底为 0 不为负');
    // 出库未填单价要被标记
    const zp = buildOrderStats([
      { order_no: 'TK-C', move_type: 'out', quantity: 1, unit_price: 0, created_at: nowIso, product: prod, product_id: 'p1' },
    ], '');
    t(zp.list[0].zeroPriceMoves === 1, 'U5.11 出库未填成交单价被标记（提示订单金额偏低）');

    /* ================= U6 报表聚合 ================= */
    reportMode = 'month'; reportYear = today.getFullYear(); reportMonth = today.getMonth() + 1;
    const rep = aggregateReport([
      { created_at: nowIso, move_type: 'out', quantity: 2, unit_price: 10, product: prod, product_id: 'p1' },
      { created_at: nowIso, move_type: 'in', is_return: true, quantity: 1, unit_price: 10, product: prod, product_id: 'p1' },
      { created_at: nowIso, move_type: 'out', quantity: 4, unit_price: 5, product: null, product_id: null },
      { created_at: nowIso, move_type: 'out', quantity: 1, unit_price: 8, product: prod, product_id: 'p1' },
      { created_at: '1999-01-01T00:00:00Z', move_type: 'out', quantity: 99, unit_price: 99, product: prod, product_id: 'p1' },
    ]);
    // 净出库：星空贴纸 (2×$10 + 1×$8 − 退货1×$10) = $18；孤儿 4×$5 = $20
    t(near(rep.total.sales, 18 * 7.2 + 20 * 7.2), 'U6.1 报表销售额按「出库 − 退货」净额 × 汇率');
    t(rep.total.qty === 6, 'U6.2 报表件数为净数量 6 件');
    t(rep.total.orders === 3 && rep.total.returns === 1 && rep.total.returnQty === 1,
      'U6.3 出库 3 笔、退货 1 笔 1 件');
    t(rep.total.orphan === 1, 'U6.4 商品已删除的出库单独计数（不计毛利）');
    const star = rep.products.filter((x) => x.name === '星空贴纸')[0];
    t(star && star.qty === 2 && near(star.sales, 18 * 7.2),
      'U6.5 销售排行按商品聚合（(2×$10+1×$8−退货$10)×7.2=¥129.60），退货已抵扣');
    t(rep.products.every((x) => x.qty !== 0), 'U6.6 净数量为 0 的商品不进排行');
    const monthBucket = rep.list.filter((b) => b.key === String(today.getFullYear()) + '-' + p2(today.getMonth() + 1))[0];
    t(monthBucket && near(monthBucket.sales, rep.total.sales), 'U6.7 当月分桶与合计一致（只统计当前周期内）');
    // 进价未填 → zeroCost 标记
    const rep2 = aggregateReport([
      { created_at: nowIso, move_type: 'out', quantity: 1, unit_price: 5, product: { id: 'p2', name: 'X', code: 'X', cost_price: 0 }, product_id: 'p2' },
    ]);
    t(rep2.total.zeroCost === 1, 'U6.8 未填进价的出库被标记（提示毛利偏高）');

    /* ================= U7 空状态文案 ================= */
    inventoryCache = [];
    t(inventoryEmptyText('') === '还没有商品，先去「商品建档」录一个', 'U7.1 空库存文案引导去建档');
    t(inventoryEmptyText('猫') === '还没有商品，先去「商品建档」录一个',
      'U7.2 库存为空时优先引导建档（不看关键字）');
    inventoryCache = [{ brand: 'A', stock: 1 }];
    t(inventoryEmptyText('猫') === '没有匹配的商品', 'U7.3 有关键字且无命中时提示无匹配');
    t(inventoryEmptyText('') === '该品牌下暂无商品', 'U7.4 有商品但该品牌为空时的文案');

    /* ================= U8 进货信息（新字段） ================= */
    inventoryCache = [
      { name: 'A', brand: 'B1', purchase_channel: '1688 批发', supplier_name: '义乌星辰日用百货', stock: 1 },
      { name: 'B', brand: '', purchase_channel: null, supplier_name: '', stock: 2 },
    ];
    const bs2 = buildBrandStats();
    t(bs2.length === 2, 'U8.1 进货字段不影响品牌聚合');
    const cardHtml = inventoryItem(inventoryCache[0]);
    t(cardHtml.innerHTML.indexOf('渠道 1688 批发') >= 0 &&
      cardHtml.innerHTML.indexOf('进货商 义乌星辰日用百货') >= 0 &&
      cardHtml.innerHTML.indexOf('item-source') >= 0,
      'U8.2 商品卡片渲染进货渠道与进货商');
    const cardHtml2 = inventoryItem(inventoryCache[1]);
    t(cardHtml2.innerHTML.indexOf('进货 —') >= 0,
      'U8.3 未登记进货信息显示「进货 —」');

    /* 进货渠道 / 进货商参与建档候选汇总（refreshBrandOptions 的候选来源） */

    /* ================= U9 报表毛利率 ================= */
    t(near(marginOf(3886.488, 3231.688), 0.831519, 0.00001),
      'U9.1 marginOf 毛利率 = 估算毛利 ÷ 销售额（10 月合计 3231.688 / 3886.488 → 83.2%）');
    t(marginOf(100, 40) === 0.4, 'U9.2 marginOf 正例：销售额 100 / 毛利 40 → 40%');
    t(marginOf(0, 100) === null && marginOf(-50, 20) === null,
      'U9.3 销售额为 0 或为负（净退货）时返回 null，不给没意义的百分比');
    t(fmtMargin(0.4) === '40.0%' && fmtMargin(0.831519) === '83.2%',
      'U9.4 fmtMargin 百分比保留一位小数');
    t(fmtMargin(null) === '—', 'U9.5 没有毛利率时显示「—」');
    t(fmtMargin(-0.2) === '-20.0%', 'U9.6 亏本周期毛利率为负，照常显示不吞掉');

    /* ================= U10 删除时的库存回补 ================= */
    t(stockDeltaForMove({ move_type: 'out', quantity: 2, is_return: false }) === 2,
      'U10.1 删除普通出库流水 → 库存加回 +2');
    t(stockDeltaForMove({ move_type: 'out', quantity: 1, is_return: true }) === -1,
      'U10.2 删除退货出库流水 → 库存减回 -1（当初退货加了 1 件）');
    t(stockDeltaForMove({ move_type: 'in', quantity: 5, is_return: false }) === -5,
      'U10.3 删除入库流水 → 库存减回 -5');
    t(stockDeltaForMove({ move_type: 'out', quantity: '3' }) === 3 &&
      stockDeltaForMove({ move_type: 'out', quantity: null }) === 0,
      'U10.4 数量字符串可解析，缺失归 0（回补不抛异常）');
    return { ok, bad };
  });

  R.ok.forEach((m) => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); });
  R.bad.forEach((m) => { fail++; failures.push(m); console.log('  \x1b[31m✗\x1b[0m ' + m); });

  section('运行健康度');
  t(pageErrors.length === 0, '无未捕获的 JS 异常' + (pageErrors.length ? '：' + pageErrors[0] : ''));
  t(consoleErrors.length === 0, '控制台无 error 级日志' + (consoleErrors.length ? '：' + consoleErrors[0] : ''));

  console.log('\n' + '─'.repeat(60));
  console.log('  单元测试通过 ' + pass + ' / ' + (pass + fail) + '    失败 ' + fail);
  if (fail) console.log('  失败项：\n' + failures.map((f) => '    · ' + f).join('\n'));
  console.log('─'.repeat(60));

  fs.mkdirSync('/tmp/mock', { recursive: true });
  fs.writeFileSync('/tmp/mock/unit-result.json', JSON.stringify({
    pass, fail, failures, consoleErrors, pageErrors, at: new Date().toISOString(),
  }, null, 2));

  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('单元测试异常：', e); process.exit(2); });
