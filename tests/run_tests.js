/* =========================================================================
   贴纸进销存 · MOCK 数据端到端测试
   数据源：fixtures.json（与云数据库中的真实数据逐行一致）
   方式：替换 cloud.* 的数据库访问层，前端业务代码 100% 真实执行
   ========================================================================= */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const FIX = JSON.parse(fs.readFileSync('/tmp/mock/fixtures.json', 'utf8'));
const BASE = 'http://127.0.0.1:8765/index.html';
const SHOT_DIR = '/tmp/mock/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

/* 期望值全部由数据库（SQL）独立算出，见 expected.json */
const EXP = JSON.parse(fs.readFileSync('/tmp/mock/expected.json', 'utf8'));

/* ---------------- 浏览器内：mock 数据访问层 ---------------- */
const INSTALL_SRC = `
window.__mockFail = null;
window.__installMockCloud = function (FX) {
  var copy = function (x) { return JSON.parse(JSON.stringify(x)); };
  var DB = {
    products: copy(FX.products),
    stock_moves: copy(FX.moves),
    order_costs: copy(FX.costs),
    order_shipments: copy(FX.shipments || []),
    app_settings: copy(FX.settings || [])
  };
  window.__DB = DB;
  var seq = 9000;

  function pick(row, cols) {
    var out = {};
    cols.forEach(function (c) { out[c] = row[c] === undefined ? null : row[c]; });
    return out;
  }
  /* select 里的嵌套字段带括号，逗号必须在顶层才切分 */
  function splitTop(s) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function project(row, sel) {
    if (!sel || sel === '*') return Object.assign({}, row);
    var out = {};
    splitTop(sel).forEach(function (part) {
      if (part === '*') { Object.assign(out, row); return; }
      var m = part.match(/^(\\w+):(\\w+)\\(([^)]*)\\)$/);
      if (m) {
        var alias = m[1], table = m[2];
        var cols = m[3].split(',').map(function (s) { return s.trim(); });
        var src = (DB[table] || []).filter(function (r) { return r.id === row[alias + '_id']; })[0];
        out[alias] = src ? pick(src, cols) : null;
        return;
      }
      m = part.match(/^(\\w+)\\(([^)]*)\\)$/);
      if (m) {
        var t2 = m[1];
        var c2 = m[2].split(',').map(function (s) { return s.trim(); });
        var s2 = (DB[t2] || []).filter(function (r) { return r.id === row.product_id; })[0];
        out[t2] = s2 ? pick(s2, c2) : null;
        return;
      }
      out[part] = row[part] === undefined ? null : row[part];
    });
    return out;
  }
  function cmp(a, b, col) {
    var va = a[col], vb = b[col];
    if (va === vb) return 0;
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return va - vb;
    return String(va) < String(vb) ? -1 : 1;
  }

  function Query(table) {
    this.table = table; this.mode = 'select'; this.payload = null; this.sel = null;
    this.returning = false; this.filters = []; this.orders = []; this.lim = null;
    this.singleMode = null;
  }
  Query.prototype.select = function (cols) {
    this.sel = cols === null || cols === undefined ? '*' : cols;
    if (this.mode !== 'select') this.returning = true;
    return this;
  };
  Query.prototype.eq = function (c, v) { this.filters.push({ op: 'eq', col: c, val: v }); return this; };
  Query.prototype.neq = function (c, v) { this.filters.push({ op: 'neq', col: c, val: v }); return this; };
  Query.prototype.ilike = function (c, v) { this.filters.push({ op: 'ilike', col: c, val: v }); return this; };
  Query.prototype.gte = function (c, v) { this.filters.push({ op: 'gte', col: c, val: v }); return this; };
  Query.prototype.lte = function (c, v) { this.filters.push({ op: 'lte', col: c, val: v }); return this; };
  Query.prototype.lt = function (c, v) { this.filters.push({ op: 'lt', col: c, val: v }); return this; };
  Query.prototype.order = function (c, o) {
    this.orders.push({ col: c, asc: !(o && o.ascending === false) });
    return this;
  };
  Query.prototype.limit = function (n) { this.lim = n; return this; };
  Query.prototype.maybeSingle = function () { this.singleMode = 'maybe'; return this; };
  Query.prototype.single = function () { this.singleMode = 'one'; return this; };
  Query.prototype.insert = function (rows) {
    this.mode = 'insert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  };
  Query.prototype.update = function (patch) { this.mode = 'update'; this.payload = patch; return this; };
  Query.prototype.delete = function () { this.mode = 'delete'; return this; };

  Query.prototype._match = function (row) {
    return this.filters.every(function (f) {
      var v = row[f.col];
      if (f.op === 'eq') {
        // is_return 这类布尔列：老数据里没有这个字段，等价于 false
        if (typeof f.val === 'boolean') return !!v === f.val;
        return String(v) === String(f.val);
      }
      if (f.op === 'neq') return String(v) !== String(f.val);
      if (f.op === 'ilike') {
        var pat = String(f.val).replace(/[.+^\\\${}()|[\\]\\\\]/g, '\\\\$&')
          .replace(/%/g, '.*').replace(/_/g, '.');
        return new RegExp('^' + pat + '$', 'i').test(String(v === null || v === undefined ? '' : v));
      }
      if (f.op === 'gte') return String(v) >= String(f.val);
      if (f.op === 'lte') return String(v) <= String(f.val);
      if (f.op === 'lt') return String(v) < String(f.val);
      return true;
    });
  };

  Query.prototype._exec = function () {
    var self = this;
    var f = window.__mockFail && window.__mockFail[self.table];
    if (f) {
      return Promise.resolve({ data: null, error: { code: f.code || 'DATABASE_XX', message: f.message || 'mock failure' } });
    }
    var rows = DB[this.table] || (DB[this.table] = []);

    if (this.mode === 'insert') {
      var added = this.payload.map(function (r) {
        var row = Object.assign({ id: ++seq, owner_id: '2110255491077648384' }, r);
        rows.push(row);
        return row;
      });
      return Promise.resolve({
        data: this.returning ? added.map(function (r) { return project(r, self.sel); }) : null,
        error: null, status: 201
      });
    }
    if (this.mode === 'update') {
      var hit = rows.filter(function (r) { return self._match(r); });
      hit.forEach(function (r) { Object.assign(r, self.payload); });
      return Promise.resolve({
        data: this.returning ? hit.map(function (r) { return project(r, self.sel); }) : null,
        error: null
      });
    }
    if (this.mode === 'delete') {
      var del = rows.filter(function (r) { return self._match(r); });
      DB[this.table] = rows.filter(function (r) { return !self._match(r); });
      return Promise.resolve({ data: del.length, error: null });
    }

    var list = rows.filter(function (r) { return self._match(r); });
    this.orders.slice().reverse().forEach(function (o) {
      list.sort(function (a, b) { return (o.asc ? 1 : -1) * cmp(a, b, o.col); });
    });
    if (this.lim !== null && this.lim !== undefined) list = list.slice(0, this.lim);

    if (this.singleMode) {
      return Promise.resolve({ data: list.length ? project(list[0], this.sel) : null, error: null });
    }
    return Promise.resolve({ data: list.map(function (r) { return project(r, self.sel); }), error: null });
  };
  Query.prototype.then = function (ok, err) { return this._exec().then(ok, err); };

  cloud.database.from = function (t) { return new Query(t); };
  cloud.auth.getSession = function () {
    return Promise.resolve({
      data: { access_token: 'mock-token', user: { id: '2110255491077648384', phone: '13800000000' } },
      error: null
    });
  };
  cloud.auth.signOut = function () { return Promise.resolve({ error: null }); };
  cloud.auth.sendOtp = function () { return Promise.resolve({ data: {}, error: null }); };
  cloud.auth.verifyOtp = function () { return Promise.resolve({ data: {}, error: null }); };
  cloud.storage.createSignedUrls = function () { return Promise.resolve({ data: [], error: null }); };
  cloud.storage.userPath = function (uid, p) { return uid + '/' + p; };
  cloud.storage.upload = function () { return Promise.resolve({ data: { path: 'mock.jpg' }, error: null }); };
  cloud.llm.models = { list: function () { return Promise.resolve({ data: [] }); } };
  return true;
};
`;

/* ---------------- 主流程 ---------------- */
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 880 } });

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.addInitScript({ content: INSTALL_SRC });
  await page.addInitScript({ content: 'try { localStorage.clear(); } catch (e) {}' });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const R = await page.evaluate(async (P) => {
    const EXP = P.EXP;
    const ok = [];
    const fail = [];
    const t = (cond, msg) => (cond ? ok : fail).push(msg);
    const $ = (id) => document.getElementById(id);
    const txt = (el) => (el ? String(el.innerText || el.textContent || '') : '');
    const money = (v) => '¥' + Number(v).toFixed(2);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const items = () => $('inventoryList').querySelectorAll('.item');
    const brandBtn = (k) => $('brandSidebar').querySelector('[data-brand="' + k + '"]');
    const setInput = (id, v) => {
      const el = $(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const waitFor = async (fn, ms) => {
      const t0 = Date.now();
      const lim = ms || 3000;
      while (Date.now() - t0 < lim) {
        try { if (fn()) return true; } catch (e) { /* retry */ }
        await sleep(30);
      }
      return false;
    };
    const num = (s) => Number(String(s == null ? '' : s).replace(/[^\d.\-]/g, ''));
    const near = (s, v, eps) => Math.abs(num(s) - v) <= (eps || 0.02);
    const osVal = (label) => {
      const boxes = Array.from($('orderSummary').querySelectorAll('.order-sum-grid > div'));
      const b = boxes.filter((x) => txt(x.querySelector('.os-label')) === label)[0];
      return b ? txt(b.querySelector('.os-value')) : null;
    };

    /* ================= 安装 mock ================= */
    window.__installMockCloud(P.FX);
    await enterApp();
    await sleep(60);

    /* ================= T1 应用装载 ================= */
    t(!$('appView').classList.contains('hidden'), 'T1.1 已登录：主界面可见');
    t($('loginView').classList.contains('hidden'), 'T1.2 登录页已隐藏');
    t(txt($('userPhone')).indexOf('****') >= 0, 'T1.3 顶栏手机号脱敏显示（' + txt($('userPhone')) + '）');
    t($('brandOptions').children.length === 8,
      'T1.4 品牌候选下拉自动汇总出 ' + $('brandOptions').children.length + ' 个品牌（不含未标注品牌的 2 款）');
    t($('rateBtn').textContent.indexOf('$1 ≈ ¥') >= 0,
      'T1.5 顶栏显示美元兑人民币汇率「' + txt($('rateBtn')) + '」');
    t(txt($('dropHint')).indexOf('拖') >= 0,
      'T1.6 上传框提示「' + txt($('dropHint')) + '」，引导拖拽建档');

    /* 照片拖拽建档：先给页面造一张真 PNG，再模拟拖放流程 */
    switchTab('create');
    await sleep(60);
    const zone = $('uploadZone');
    const makeDt = async (name, type, bytes) => {
      const dt = new DataTransfer();
      if (type.startsWith('image/')) {
        const blob = await new Promise((res) => {
          const c = document.createElement('canvas');
          c.width = 80; c.height = 80;
          const g = c.getContext('2d');
          g.fillStyle = '#4f46e5'; g.fillRect(0, 0, 80, 80);
          g.fillStyle = '#fff'; g.fillRect(24, 24, 32, 32);
          c.toBlob(res, 'image/png');
        });
        dt.items.add(new File([blob], name, { type }));
      } else {
        dt.items.add(new File([new Uint8Array(bytes || [1, 2, 3])], name, { type }));
      }
      return dt;
    };
    const fireDrag = (el, type, dt) => el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, dataTransfer: dt,
    }));

    const imgDt = await makeDt('drop-product.png', 'image/png');
    fireDrag(zone, 'dragenter', imgDt);
    fireDrag(zone, 'dragover', imgDt);
    await sleep(60);
    t(zone.classList.contains('is-dragover') && txt($('dropHint')).indexOf('松手') >= 0,
      'T1.7 照片悬停在上传框时高亮并提示「' + txt($('dropHint')) + '」');

    fireDrag(zone, 'drop', imgDt);
    await sleep(400);
    t(!zone.classList.contains('is-dragover') && txt($('dropHint')).indexOf('拖') >= 0,
      'T1.8 松手后高亮收起、提示文案复原');
    t(!$('previewImg').classList.contains('hidden') &&
      $('previewImg').src.indexOf('data:image') === 0 &&
      $('uploadPlaceholder').classList.contains('hidden') &&
      $('recognizeBtn').disabled === false,
      'T1.9 拖入的照片直接进了预览框，「开始 AI 识别」可点');

    /* 拖进来的不是文件（比如选中的一段文字）：不该亮起上传框 */
    const selDt = new DataTransfer();
    selDt.setData('text/plain', '随便一段文字');
    fireDrag(zone, 'dragenter', selDt);
    await sleep(40);
    t(!zone.classList.contains('is-dragover'),
      'T1.10 拖的是文字而不是文件时，上传框不高亮');

    /* 拖错文件类型：拦截 + 不污染已有预览 */
    const txtDt = await makeDt('readme.txt', 'text/plain');
    fireDrag(zone, 'dragenter', txtDt);
    fireDrag(zone, 'dragover', txtDt);
    await sleep(40);
    t(zone.classList.contains('is-dragover'), 'T1.11 拖入文件（无论类型）会先高亮，松手时才校验类型');
    fireDrag(zone, 'drop', txtDt);
    await sleep(200);
    t(txt($('toast')).indexOf('只能拖入图片') >= 0 && !$('previewImg').classList.contains('hidden') &&
      !zone.classList.contains('is-dragover'),
      'T1.12 拖入非图片被拦下（' + txt($('toast')) + '），原预览不受影响');

    /* 清空 / 重新建档后回到初始态 */
    resetCreate();
    await sleep(60);
    t($('previewImg').classList.contains('hidden') &&
      !$('uploadPlaceholder').classList.contains('hidden') &&
      $('recognizeBtn').disabled === true,
      'T1.13 清除照片后上传框回到初始空状态');
    t($('fStock').value === '1',
      'T11.1 手动建档「初始库存」默认 1 件（实测 ' + $('fStock').value + '）');

    /* AI 识别回填表单后，初始库存同样是 1 件，不用手动改 */
    await fillReviewForm({ name: '识别回填测试商品', brand: '纸间集' });
    t($('fStock').value === '1',
      'T11.2 AI 识别回填后「初始库存」仍默认 1 件（实测 ' + $('fStock').value + '）');
    resetCreate();
    await sleep(40);

    /* ================= T2 库存页 ================= */
    switchTab('inventory');
    await waitFor(() => items().length > 0);

    t(items().length === EXP.products_total, 'T2.1 库存页加载 ' + items().length + ' 款商品（DB 实测 ' + EXP.products_total + '）');
    t(txt($('inventoryCount')) === '共 ' + EXP.products_total + ' 款商品', 'T2.2 计数文案「' + txt($('inventoryCount')) + '」');

    const sidebar = $('brandSidebar');
    const brandItems = sidebar.querySelectorAll('.brand-item');
    t(brandItems.length === EXP.brands.length + 1,
      'T2.3 左侧品牌栏 ' + brandItems.length + ' 项 = 全部商品 + ' + EXP.brands.length + ' 个品牌');

    let brandOk = true;
    const brandDetail = [];
    EXP.brands.forEach((b) => {
      const key = b[0];
      const btn = brandBtn(key);
      const want = key === '__none__' ? '未标注品牌' : key;
      if (!btn) { brandOk = false; brandDetail.push(key + ' 缺失'); return; }
      const cnt = txt(btn.querySelector('.brand-count'));
      if (cnt !== String(b[1])) { brandOk = false; brandDetail.push(key + ' 计数 ' + cnt + '≠' + b[1]); }
      if (txt(btn.querySelector('.brand-name')) !== want) { brandOk = false; brandDetail.push(key + ' 名称不符'); }
    });
    t(brandOk, 'T2.4 各品牌商品数与数据库一致' + (brandOk ? '' : '（' + brandDetail.join('；') + '）'));

    const lastBrand = brandItems[brandItems.length - 1];
    t(lastBrand.dataset.brand === '__none__', 'T2.5「未标注品牌」固定在最后一项');

    const bTitle = brandBtn('纸间集') ? brandBtn('纸间集').getAttribute('title') : '';
    const zjj = EXP.brands.filter((b) => b[0] === '纸间集')[0];
    t(bTitle.indexOf('库存 ' + zjj[2] + ' 件') >= 0, 'T2.6 品牌悬停信息含库存合计（' + bTitle + '）');

    t($('inventoryList').querySelectorAll('.badge.out').length === EXP.out_of_stock,
      'T2.7 缺货标签 ' + $('inventoryList').querySelectorAll('.badge.out').length + ' 个（DB 实测 ' + EXP.out_of_stock + '）');
    t($('inventoryList').querySelectorAll('.badge.low').length === EXP.low_stock,
      'T2.8 库存偏低标签 ' + $('inventoryList').querySelectorAll('.badge.low').length + ' 个（DB 实测 ' + EXP.low_stock + '）');

    /* 缺货商品：出库销售按钮置灰不可点，补货按钮仍可用 */
    let outBtnCount = { total: 0, disabled: 0, inOk: 0, lowDisabled: 0, blue: 0, urge: 0, urgeWrong: 0 };
    items().forEach((el) => {
      const outBtn = el.querySelector('[data-act="out"]');
      const inBtn = el.querySelector('[data-act="in"]');
      const badgeOut = !!el.querySelector('.badge.out');
      outBtnCount.total++;
      if (outBtn.disabled) outBtnCount.disabled++;
      if (badgeOut && outBtn.disabled) outBtnCount.inOk++;
      if (inBtn.disabled) outBtnCount.lowDisabled++;
      if (inBtn.classList.contains('blue')) outBtnCount.blue++;
      if (inBtn.classList.contains('urge')) {
        outBtnCount.urge++;
        if (!badgeOut) outBtnCount.urgeWrong++;
      }
    });
    t(outBtnCount.total === EXP.products_total, 'T2.9 列表共 ' + outBtnCount.total + ' 款商品，每款都有出库按钮');
    t(outBtnCount.disabled === EXP.out_of_stock,
      'T2.10 缺货商品的「出库销售」按钮全部置灰（' + outBtnCount.disabled + ' 个 / DB 实测缺货 ' + EXP.out_of_stock + ' 款）');
    t(outBtnCount.inOk === EXP.out_of_stock, 'T2.11 置灰的正好都是带「缺货」标签的商品');
    t(outBtnCount.lowDisabled === 0, 'T2.12 缺货商品的「补货」按钮仍可点击（不被连带禁用）');
    t(outBtnCount.blue === EXP.out_of_stock,
      'T2.13 只有缺货商品的「补货」按钮是蓝色（' + outBtnCount.blue + ' 个 / DB 实测缺货 ' + EXP.out_of_stock + ' 款）');
    t(outBtnCount.urge === EXP.out_of_stock && outBtnCount.urgeWrong === 0,
      'T2.14 缺货商品的「补货」按钮额外加高亮（' + outBtnCount.urge + ' 个，非缺货 ' + outBtnCount.urgeWrong + ' 个）');
    const plainIn = outBtnCount.total - outBtnCount.blue;
    t(plainIn === EXP.products_total - EXP.out_of_stock,
      'T2.14b 非缺货商品的「补货」按钮为普通样式（' + plainIn + ' 个，不与缺货抢注意力）');

    /* 点缺货商品的出库按钮：不应弹出出库弹窗 */
    const outItem = Array.from(items()).filter((el) => el.querySelector('.badge.out'))[0];
    const disabledOut = outItem.querySelector('[data-act="out"]');
    disabledOut.click();
    await sleep(60);
    t($('modal').classList.contains('hidden') !== false, 'T2.15 点击置灰的「出库销售」按钮不弹出出库弹窗');

    /* 筛选：按品牌 */
    brandBtn('纸间集').click();
    await sleep(60);
    const zjjCount = EXP.brands.filter((b) => b[0] === '纸间集')[0][1];
    t(items().length === zjjCount, 'T2.16 点「纸间集」筛出 ' + items().length + ' 款（DB 实测 ' + zjjCount + '）');
    t(/筛选出 \d+ 款 \/ 共 \d+ 款商品/.test(txt($('inventoryCount'))), 'T2.17 筛选时计数文案切换为「' + txt($('inventoryCount')) + '」');

    brandBtn('__all__').click();
    await sleep(60);
    t(items().length === EXP.products_total, 'T2.18 回到「全部商品」恢复 ' + items().length + ' 款');

    /* 筛选：关键词 */
    setInput('searchInput', '猫');
    await sleep(60);
    t(items().length === EXP.hit_cat, 'T2.19 搜索「猫」命中 ' + items().length + ' 款（DB 实测 ' + EXP.hit_cat + '）');

    setInput('searchInput', 'mk20261014001');
    await sleep(60);
    t(items().length === EXP.hit_code, 'T2.20 搜索编码（小写）命中 ' + items().length + ' 款');

    setInput('searchInput', 'zzz-not-exist');
    await sleep(60);
    t(txt($('inventoryList')) === '没有匹配的商品', 'T2.21 无结果时提示「' + txt($('inventoryList')) + '」');

    setInput('searchInput', '');
    await sleep(60);

    /* 品牌 + 关键词组合 */
    brandBtn('纸间集').click();
    await sleep(60);
    setInput('searchInput', '贴纸');
    await sleep(60);
    t(items().length === 5, 'T2.22 品牌「纸间集」+ 关键词「贴纸」= ' + items().length + ' 款（DB 实测 5）');
    setInput('searchInput', '');
    brandBtn('__all__').click();
    await sleep(60);

    /* 商品卡片时间字段 */
    const card001 = Array.from(items()).filter((el) => txt(el).indexOf('MK20261014001') >= 0)[0];
    t(!!card001 && txt(card001).indexOf('2026-10-14 13:30') >= 0, 'T2.23 商品卡片显示最近入库时间 2026-10-14 13:30');
    t(!!card001 && txt(card001).indexOf('2026-09-02 17:00') >= 0, 'T2.24 商品卡片显示最近出库时间 2026-09-02 17:00');

    /* 价格币种：进价是人民币、售价是美元，符号要能看出币种 */
    const priceLine = card001 ? txt(card001.querySelector('.item-meta')) : '';
    t(/进价 ¥[\d.]+ · 售价 \$[\d.]+/.test(priceLine),
      'T2.25 商品卡片按币种显示价格（' + priceLine.replace(/\s+/g, ' ').trim() + '）');
    const card017 = Array.from(items()).filter((el) => txt(el).indexOf('MK20261014017') >= 0)[0];
    t(!!card017 && txt(card017).indexOf('出库') >= 0 && /出库\s*—/.test(txt(card017).replace(/\s+/g, ' ')),
      'T2.25 从未出库的商品出库时间显示「—」');

    /* ================= T3 出入库流水 ================= */
    switchTab('moves');
    await waitFor(() => $('movesList').querySelectorAll('.item').length > 0);

    t($('movesList').querySelectorAll('.item').length === EXP.window_total,
      'T3.1 流水列表加载 ' + $('movesList').querySelectorAll('.item').length + ' 条（服务端 limit 200，DB 共 ' + EXP.moves_total + ' 条）');
    t(txt($('movesCount')) === '共 ' + EXP.window_total + ' 条记录', 'T3.2 计数文案「' + txt($('movesCount')) + '」');
    t(txt($('movesList')).indexOf('未关联订单') >= 0, 'T3.3 无订单号的出库显示「未关联订单」');
    t($('movesList').querySelectorAll('.order-chip').length === EXP.window_chips,
      'T3.4 有订单号的流水渲染为可点击订单标签 ' + $('movesList').querySelectorAll('.order-chip').length + ' 个（DB 实测 ' + EXP.window_chips + '）');

    setInput('moveBuyerInput', 'jessica');
    await sleep(60);
    t($('movesList').querySelectorAll('.item').length === EXP.window_jessica,
      'T3.5 按购买者姓名「jessica」筛出 ' + $('movesList').querySelectorAll('.item').length + ' 条（DB 实测 ' + EXP.window_jessica + '）');
    t(/筛选出 \d+ 条 \/ 共 \d+ 条/.test(txt($('movesCount'))), 'T3.6 筛选计数文案「' + txt($('movesCount')) + '」');

    /* 购买者筛选只认姓名：电话 / 地址 / 备注都不参与匹配 */
    setInput('moveBuyerInput', '555');
    await sleep(60);
    t($('movesList').querySelectorAll('.item').length === EXP.window_phone555 &&
      txt($('movesList')).indexOf('没有匹配的流水记录') >= 0,
      'T3.6b 按电话片段「555」命中 ' + $('movesList').querySelectorAll('.item').length +
      ' 条（购买者筛选只认姓名，不再搜电话 / 地址 / 备注）');

    setInput('moveBuyerInput', '');
    setInput('moveProductInput', 'MK20261014001');
    await sleep(60);
    const mk001 = $('movesList').querySelectorAll('.item').length;
    t(mk001 === EXP.window_mk001_all, 'T3.7 按商品「MK20261014001」筛出 ' + mk001 + ' 条（该 SKU 在 200 条窗口内共 ' + EXP.window_mk001_all + ' 笔：出库 ' + EXP.window_mk001_out + ' + 入库 ' + (EXP.window_mk001_all - EXP.window_mk001_out) + '）');
    setInput('moveProductInput', '');
    await sleep(60);

    /* 只看某个订单（已无手输筛选框，改由订单号标签 / 订单管理页写入）+ 结算卡 */
    setMoveOrderFilter('MOCK-TK2026101064');
    await waitFor(() => $('orderSummary').querySelectorAll('.order-sum-card').length > 0);
    const o = EXP.order_1064;
    const sumHtml = $('orderSummary').innerText;
    t($('movesList').querySelectorAll('.item').length === o.moves,
      'T3.8 只看订单时筛出 ' + $('movesList').querySelectorAll('.item').length + ' 条流水（DB 实测 ' + o.moves + '）');
    t($('orderSummary').classList.contains('hidden') === false, 'T3.9 订单结算区自动出现');
    t(near(osVal('订单金额'), o.sales), 'T3.10 订单金额 ' + osVal('订单金额') + '（DB 实测 ¥' + o.sales.toFixed(2) + '）');
    t(near(osVal('商品成本'), o.cost), 'T3.11 商品成本 ' + osVal('商品成本') + '（按商品当前进价 ¥' + o.cost.toFixed(2) + '）');
    t(near(osVal('其他成本'), o.other_cost), 'T3.12 其他成本 ' + osVal('其他成本') + '（用户录入的整单费用）');
    t(near(osVal('净利润'), o.net), 'T3.13 净利润 ' + osVal('净利润') + ' = 金额 - 商品成本 - 其他成本');
    t(sumHtml.indexOf((o.margin * 100).toFixed(1) + '%') >= 0, 'T3.14 毛利率 ' + (o.margin * 100).toFixed(1) + '%');
    t(/修改其他成本/.test(sumHtml), 'T3.15 已录其他成本时按钮文案为「修改其他成本」');
    t(/is-net/.test($('orderSummary').innerHTML), 'T3.16 盈利订单用绿色样式标注');

    /* 点流水里的订单标签 → 只看该订单 */
    setMoveOrderFilter('');
    await sleep(60);
    const chip = Array.from($('movesList').querySelectorAll('.order-chip')).filter((c) => c.dataset.order === 'MOCK-TK2026101064')[0];
    t(!!chip, 'T3.17 列表中存在订单 MOCK-TK2026101064 的标签');
    if (chip) {
      chip.click();
      await waitFor(() => !$('moveOrderFilter').classList.contains('hidden'));
      t($('moveOrderFilter').classList.contains('hidden') === false &&
        $('moveOrderFilter').textContent.indexOf('MOCK-TK2026101064') >= 0,
        'T3.18 点击订单标签后出现「' + txt($('moveOrderFilter')) + '」标签并筛出该单流水');
    }

    clearMoveFilter();
    await sleep(60);
    t($('movesList').querySelectorAll('.item').length === EXP.window_total, 'T3.19 清空筛选恢复 ' + EXP.window_total + ' 条');
    t($('orderSummary').classList.contains('hidden') === true, 'T3.20 清空筛选后订单结算区隐藏');

    /* 筛选标签本身可点：再点一次 = 取消「只看该订单」 */
    const chip2 = Array.from($('movesList').querySelectorAll('.order-chip')).filter((c) => c.dataset.order === 'MOCK-TK2026101064')[0];
    if (chip2) chip2.click();
    await waitFor(() => !$('moveOrderFilter').classList.contains('hidden'));
    $('moveOrderFilter').click();
    await sleep(60);
    t($('moveOrderFilter').classList.contains('hidden') === true &&
      $('movesList').querySelectorAll('.item').length === EXP.window_total,
      'T3.21 点订单筛选标签即可取消，恢复全量 ' + EXP.window_total + ' 条');
    t(!document.getElementById('moveOrderInput'), 'T3.22 流水页已去掉「按订单 ID」手工筛选输入框');

    /* 流水条目：购买者只读展示，不再提供修改入口 */
    const movesTxt = txt($('movesList'));
    t($('movesList').querySelectorAll('[data-buyer]').length === 0 &&
      movesTxt.indexOf('修改购买者') < 0 && movesTxt.indexOf('补录购买者') < 0,
      'T3.23 流水条目已去掉「修改购买者 / 补录购买者」按钮');
    t(movesTxt.indexOf('购买者：') >= 0 && movesTxt.indexOf('未填写') >= 0,
      'T3.24 购买者信息仍以只读文本展示（未填写的显示「未填写」）');

    /* 只看入库 / 只看出库 */
    const kindBtn = (k) => $('moveKindSeg').querySelector('[data-kind="' + k + '"]');
    kindBtn('out').click();
    await sleep(60);
    const outOnly = $('movesList').querySelectorAll('.item').length;
    t(outOnly === EXP.window_total - EXP.window_in_total &&
      $('movesList').querySelectorAll('.badge.in').length === 0,
      'T3.25 只看出库：' + outOnly + ' 条（= 窗口 ' + EXP.window_total + ' − 入库 ' + EXP.window_in_total + '），列表无入库标记');

    kindBtn('in').click();
    await sleep(60);
    t($('movesList').querySelectorAll('.item').length === EXP.window_in_total &&
      $('movesList').querySelectorAll('.badge.sale').length === 0,
      'T3.26 只看入库：' + $('movesList').querySelectorAll('.item').length +
      ' 条（DB 实测入库 ' + EXP.window_in_total + ' 条），列表无出库标记');

    kindBtn('all').click();
    await sleep(60);
    t($('movesList').querySelectorAll('.item').length === EXP.window_total &&
      txt($('movesCount')) === '共 ' + EXP.window_total + ' 条记录',
      'T3.27 切回「全部」恢复 ' + EXP.window_total + ' 条');

    /* ================= T4 统计报表 ================= */
    switchTab('report');
    await waitFor(() => $('reportBody').querySelectorAll('.stat-card').length === 5);

    const statVal = (label) => {
      const cards = Array.from($('reportBody').querySelectorAll('.stat-card'));
      const c = cards.filter((x) => txt(x.querySelector('.stat-label')) === label)[0];
      return c ? txt(c.querySelector('.stat-value')) : null;
    };
    const M = EXP.report;
    t(near(statVal('销售额'), M.month202610.sales), 'T4.1 按日（2026-10）销售额 ' + statVal('销售额') + '（DB 实测 ' + money(M.month202610.sales) + '）');
    t(statVal('销售件数') === M.month202610.qty + ' 件', 'T4.2 按日（2026-10）销售件数 ' + statVal('销售件数') + '（DB 实测 ' + M.month202610.qty + ' 件）');
    t(statVal('出库笔数') === M.month202610.orders + ' 笔', 'T4.3 按日（2026-10）出库笔数 ' + statVal('出库笔数') + '（DB 实测 ' + M.month202610.orders + ' 笔）');
    t(near(statVal('估算毛利'), M.month202610.profit), 'T4.4 按日（2026-10）估算毛利 ' + statVal('估算毛利') + '（DB 实测 ' + money(M.month202610.profit) + '）');
    t(txt($('reportRangeLabel')).indexOf('2026 年 10 月 · 按日统计') >= 0, 'T4.5 区间标签「' + txt($('reportRangeLabel')) + '」');

    const bars = $('reportBody').querySelectorAll('.bar-col').length;
    t(bars === 31, 'T4.6 按日图表渲染 31 根柱子（当月天数）');
    t($('reportBody').innerText.indexOf(Number(M.day20261014.sales).toFixed(2)) >= 0,
      'T4.7 明细含 2026-10-14：销售额 ' + money(M.day20261014.sales) + '（成交价按 $1≈¥' + EXP.rate + ' 折算）');
    t($('reportBody').innerText.indexOf(Number(M.day20261014.profit).toFixed(2)) >= 0,
      'T4.8 明细含 2026-10-14：' + M.day20261014.qty + ' 件、毛利 ' + money(M.day20261014.profit) + '（DB 实测）');
    t($('reportBody').innerText.indexOf('商品销售排行') >= 0, 'T4.9 渲染商品销售排行');
    t($('reportBody').innerText.indexOf(EXP.top_oct[0]) >= 0, 'T4.10 10 月排行第一为「' + EXP.top_oct[0] + '」');
    t($('reportBody').innerText.indexOf(Number(EXP.top_oct[1]).toFixed(2)) >= 0,
      'T4.11 10 月排行第一销售额 ¥' + Number(EXP.top_oct[1]).toFixed(2) + '（DB 实测）');
    t(/笔商品未填进价/.test(txt($('reportBody'))), 'T4.12 对未填进价的商品给出毛利偏高提示');

    /* 按月 */
    $('reportModeSeg').querySelector('[data-mode="month"]').click();
    await waitFor(() => near(statVal('销售额'), M.year2026.sales));
    t(near(statVal('销售额'), M.year2026.sales), 'T4.13 按月（2026 年）销售额 ' + statVal('销售额') + '（DB 实测 ' + money(M.year2026.sales) + '）');
    t(statVal('销售件数') === M.year2026.qty + ' 件', 'T4.14 按月（2026 年）销售件数 ' + statVal('销售件数') + '（DB 实测 ' + M.year2026.qty + ' 件）');
    t(near(statVal('估算毛利'), M.year2026.profit), 'T4.15 按月（2026 年）估算毛利 ' + statVal('估算毛利') + '（DB 实测 ' + money(M.year2026.profit) + '）');
    t($('reportBody').querySelectorAll('.bar-col').length === 12, 'T4.16 按月图表渲染 12 根柱子');

    /* 按年 */
    $('reportModeSeg').querySelector('[data-mode="year"]').click();
    await waitFor(() => near(statVal('销售额'), M.all.sales));
    t(near(statVal('销售额'), M.all.sales), 'T4.17 按年销售额 ' + statVal('销售额') + '（2025 + 2026 = DB 实测 ' + money(M.all.sales) + '）');
    t(statVal('出库笔数') === M.all.orders + ' 笔', 'T4.18 按年出库笔数 ' + statVal('出库笔数') + '（DB 实测 ' + M.all.orders + ' 笔）');
    t($('reportBody').querySelectorAll('.bar-col').length === 2, 'T4.19 按年图表渲染 2 根柱子（2025 / 2026）');
    t($('reportBody').innerText.indexOf(Number(M.year2025.sales).toFixed(2)) >= 0,
      'T4.20 2025 年销售额 ' + money(M.year2025.sales) + ' 出现在明细中');

    $('reportModeSeg').querySelector('[data-mode="day"]').click();
    await waitFor(() => $('reportBody').querySelectorAll('.bar-col').length === 31);

    /* ================= T12 报表 · 毛利率 ================= */
    const wantMargin = (o) => (o.sales > 0 ? (o.profit / o.sales * 100).toFixed(1) + '%' : '—');
    t(statVal('毛利率') === wantMargin(M.month202610),
      'T12.1 按日（2026-10）合计毛利率 ' + statVal('毛利率') +
      '（= 估算毛利 ' + money(M.month202610.profit) + ' ÷ 销售额 ' + money(M.month202610.sales) + '，DB 实测）');

    const headThs = Array.from($('reportBody').querySelectorAll('.report-table thead th')).map(txt);
    t(headThs.length === 6 && headThs[5] === '毛利率',
      'T12.2 明细表新增「毛利率」列（' + headThs.join(' / ') + '）');

    const trRows = Array.from($('reportBody').querySelectorAll('.report-table tbody tr'));
    const row14 = trRows.filter((tr) => txt(tr.querySelectorAll('td')[0]).indexOf('2026-10-14') >= 0)[0];
    t(!!row14 && txt(row14.querySelectorAll('td')[5]) === wantMargin(M.day20261014),
      'T12.3 10-14 行毛利率 ' + (row14 ? txt(row14.querySelectorAll('td')[5]) : '缺失') +
      '（= ' + money(M.day20261014.profit) + ' ÷ ' + money(M.day20261014.sales) + '）');

    const emptyRow = trRows.filter((tr) => tr.classList.contains('is-empty'))[0];
    t(!!emptyRow && txt(emptyRow.querySelectorAll('td')[5]) === '—',
      'T12.4 没有销售的日期毛利率显示「—」（' +
      (emptyRow ? txt(emptyRow.querySelectorAll('td')[0]) : '未找到空白天') + '）');

    const aggForRank = aggregateReport(reportRows);
    const p0 = aggForRank.products[0];
    const rankFirst = $('reportBody').querySelectorAll('.rank-row')[0];
    t(!!rankFirst && !!p0 && txt(rankFirst.querySelector('.rank-meta')).indexOf(wantMargin(p0)) >= 0,
      'T12.5 商品销售排行带出该商品毛利率（第一行：' +
      (rankFirst ? txt(rankFirst.querySelector('.rank-meta')) : '—') + '）');

    t(txt($('reportBody')).indexOf('估算毛利 ÷ 销售额') >= 0,
      'T12.6 报表内标明毛利率口径「估算毛利 ÷ 销售额」');

    /* ================= T5 订单出库会话（订单 ID + 客户姓名） ================= */
    switchTab('inventory');
    await waitFor(() => items().length > 0);

    /* 订单 ID 必填、客户姓名选填（客户可在订单管理页补填） */
    $('orderInput').value = '';
    $('orderBuyerInput').value = 'Alice Wang';
    $('startOrderBtn').click();
    await sleep(50);
    t($('orderBar').classList.contains('is-active') === false && txt($('toast')).indexOf('订单 ID') >= 0,
      'T5.1 只填客户姓名不填订单 ID → 拒绝开始（提示「' + txt($('toast')) + '」）');

    $('orderInput').value = 'MOCK-TK-NEW-01';
    $('orderBuyerInput').value = '';
    $('startOrderBtn').click();
    await sleep(50);
    t($('orderBar').classList.contains('is-active') && txt($('orderStatus')).indexOf('MOCK-TK-NEW-01') >= 0,
      'T5.2 只填订单 ID、不填客户姓名 → 允许开始出库（姓名改为选填）');

    $('orderInput').value = 'MOCK-TK-NEW-01';
    $('orderBuyerInput').value = 'Alice Wang';
    $('startOrderBtn').click();
    await sleep(50);
    t(txt($('orderStatus')).indexOf('MOCK-TK-NEW-01') >= 0 && txt($('orderStatus')).indexOf('Alice Wang') >= 0,
      'T5.3 补填客户姓名后，当前会话立即带上客户');
    t(txt($('orderStatus')).indexOf('MOCK-TK-NEW-01') >= 0 && txt($('orderStatus')).indexOf('Alice Wang') >= 0,
      'T5.4 状态栏同时显示订单号与客户姓名');
    t($('endOrderBtn').disabled === false, 'T5.5「出库结束」按钮可用');
    t($('orderInput').value === '' && $('orderBuyerInput').value === '',
      'T5.6 开始出库后两个输入框都被清空');

    $('orderInput').value = 'MOCK-TK-NEW-02';
    $('orderBuyerInput').value = 'Bob Li';
    $('startOrderBtn').click();
    await sleep(50);
    t(txt($('orderStatus')).indexOf('MOCK-TK-NEW-02') >= 0 && txt($('orderStatus')).indexOf('Bob Li') >= 0,
      'T5.7 输入新订单号+新客户 → 自动结束上一单并切换');

    $('orderInput').value = 'MOCK-TK-NEW-02';
    $('orderBuyerInput').value = 'Bob Liu';
    $('startOrderBtn').click();
    await sleep(50);
    t(txt($('orderStatus')).indexOf('Bob Liu') >= 0,
      'T5.8 同一订单号换客户姓名 → 直接更新当前会话（不重开）');

    const lsKey = 'sticker.activeOrder';
    const stored = JSON.parse(localStorage.getItem(lsKey) || 'null');
    t(!!stored && stored.no === 'MOCK-TK-NEW-02' && stored.buyerName === 'Bob Liu',
      'T5.9 出库会话（订单号 + 客户姓名）写入 localStorage，刷新不丢');

    $('endOrderBtn').click();
    await sleep(50);
    t($('orderBar').classList.contains('is-active') === false, 'T5.10 点「出库结束」退出出库中状态');
    t(localStorage.getItem(lsKey) === null, 'T5.11 结束后清掉 localStorage 会话');

    /* ================= T6 写操作（走真实业务函数） ================= */
    const before = window.__DB.stock_moves.length;
    const p001 = inventoryCache.filter((p) => p.code === 'MK20261014001')[0];
    const stockBefore = Number(p001.stock);
    $('orderInput').value = 'MOCK-TK-WRITE';
    $('orderBuyerInput').value = 'Jessica Miller';
    $('startOrderBtn').click();
    await sleep(30);
    openMoveDialog(p001, 'out');
    await sleep(30);
    t(!$('mOrder'), 'T6.1 出库弹窗已去掉「订单 ID」输入框');
    t(/当前出库订单/.test(txt($('modalBody'))) &&
      txt($('modalBody')).indexOf('MOCK-TK-WRITE') >= 0 &&
      txt($('modalBody')).indexOf('Jessica Miller') >= 0,
      'T6.2 弹窗只读展示当前正在出库的订单号与客户姓名');
    t(!$('bName') && !$('bPhone') && !$('bAddr'),
      'T6.3 出库弹窗已去掉姓名 / 电话 / 地址输入框');
    $('mQty').value = '2';
    $('mPrice').value = '6.99';
    $('bNote').value = '优先发货';
    const closed = await submitMove(p001, 'out');
    await sleep(80);
    t(closed === false, 'T6.4 出库提交成功（弹窗正常关闭）');
    t(window.__DB.stock_moves.length === before + 1, 'T6.5 流水表新增 1 条出库记录');
    const lastMove = window.__DB.stock_moves[window.__DB.stock_moves.length - 1];
    t(lastMove.order_no === 'MOCK-TK-WRITE' && lastMove.buyer_name === 'Jessica Miller',
      'T6.6 订单号与客户姓名由出库会话自动落库（无需手填）');
    t(lastMove.buyer_note === '优先发货', 'T6.7 备注仍可填写并落库');
    t((lastMove.buyer_phone || null) === null && (lastMove.buyer_addr || null) === null,
      'T6.8 不再写入电话 / 地址（保持为空）');
    const p001After = inventoryCache.filter((p) => p.code === 'MK20261014001')[0];
    t(Number(p001After.stock) === stockBefore - 2, 'T6.9 库存从 ' + stockBefore + ' 减到 ' + p001After.stock + '（出库 2 件）');
    t(!!p001After.last_out_at, 'T6.10 商品「最近出库时间」被刷新');

    /* 库存不足拦截 */
    openMoveDialog(p001After, 'out');
    await sleep(30);
    $('mQty').value = '99999';
    const blocked = await submitMove(p001After, 'out');
    t(blocked === true && /库存不足/.test(txt($('modalError'))), 'T6.11 出库数量超过库存被拦截（' + txt($('modalError')) + '）');
    closeModal();

    /* 同一订单换客户：会话更新后，后续出库带新客户 */
    $('orderInput').value = 'MOCK-TK-WRITE';
    $('orderBuyerInput').value = 'Carol Sun';
    $('startOrderBtn').click();
    await sleep(30);
    openMoveDialog(p001After, 'out');
    await sleep(30);
    t(txt($('modalBody')).indexOf('Carol Sun') >= 0,
      'T6.12 同订单换客户后，弹窗带出更新后的客户姓名 Carol Sun');
    $('mQty').value = '1';
    $('mPrice').value = '6.99';
    await submitMove(p001After, 'out');
    await sleep(80);
    closeModal();   // 真实界面由弹窗「确定」按钮关闭，这里直接调函数，手动收尾
    const renameMove = window.__DB.stock_moves[window.__DB.stock_moves.length - 1];
    t(renameMove.order_no === 'MOCK-TK-WRITE' && renameMove.buyer_name === 'Carol Sun',
      'T6.13 改客户后的出库按新客户落库');
    endOrder();
    await sleep(30);

    /* 出库必须关联订单号：未开单时点「出库销售」要被拦下，不能再产出无主散单 */
    const p001b = inventoryCache.filter((p) => p.code === 'MK20261014001')[0];
    openMoveDialog(p001b, 'out');
    await sleep(30);
    t($('modal').classList.contains('hidden') !== false && txt($('toast')).indexOf('订单号') >= 0,
      'T6.14 未开单时点「出库销售」不弹窗，提示先填写订单 ID（' + txt($('toast')) + '）');

    /* 极端情况：弹窗 DOM 还在（例如页面残留在旧会话状态），业务函数也必须拦得住 */
    openModal('出库',
      '<label class="field"><span>数量</span><input id="mQty" type="number" value="1"></label>' +
      '<label class="field"><span>成交单价（美元 $）</span><input id="mPrice" type="number" value="6.99"></label>',
      null);
    await sleep(30);
    const blockedOut = await submitMove(p001b, 'out');
    await sleep(30);
    t(blockedOut === true && txt($('modalError')).indexOf('订单号') >= 0,
      'T6.15 直接调用业务函数同样被拦下（出库必须关联订单号）');
    closeModal();
    await sleep(30);

    /* 补货 */
    const stockB2 = Number(inventoryCache.filter((p) => p.code === 'MK20261014001')[0].stock);
    openMoveDialog(inventoryCache.filter((p) => p.code === 'MK20261014001')[0], 'in');
    await sleep(30);
    $('mQty').value = '10';
    await submitMove(inventoryCache.filter((p) => p.code === 'MK20261014001')[0], 'in');
    await sleep(80);
    const stockA2 = Number(inventoryCache.filter((p) => p.code === 'MK20261014001')[0].stock);
    t(stockA2 === stockB2 + 10, 'T6.16 补货 10 件后库存 ' + stockB2 + ' → ' + stockA2);
    endOrder();
    await sleep(30);

    /* ================= T7 降级与容错 ================= */
    window.__mockFail = { products: { code: 'DATABASE_500', message: '模拟数据库故障' } };
    switchTab('moves');
    await sleep(60);
    await loadInventory();
    await sleep(60);
    t(txt($('inventoryList')).indexOf('模拟数据库故障') >= 0,
      'T7.1 库存查询失败时展示可读错误而不是白屏（' + txt($('inventoryList')).slice(0, 20) + '）');
    window.__mockFail = null;
    await loadInventory();
    await sleep(60);
    t(items().length === EXP.products_total, 'T7.2 故障恢复后库存列表重新加载 ' + items().length + ' 款');

    window.__mockFail = { order_costs: { code: 'DATABASE_500', message: '成本表故障' } };
    await loadMoves();
    await sleep(80);
    t($('movesList').querySelectorAll('.item').length > 0, 'T7.3 订单成本表故障不影响流水列表渲染');
    window.__mockFail = null;

    window.__mockFail = { stock_moves: { code: 'DATABASE_500', message: '流水表故障' } };
    await loadMoves();
    await sleep(60);
    t(txt($('movesList')).indexOf('流水表故障') >= 0, 'T7.4 流水查询失败时给出可读错误提示');
    window.__mockFail = null;
    await loadMoves();
    await sleep(60);

    /* ================= T8 空数据处理 ================= */
    const backupProducts = window.__DB.products;
    const backupMoves = window.__DB.stock_moves;
    const backupCosts = window.__DB.order_costs;
    window.__DB.products = [];
    window.__DB.stock_moves = [];
    window.__DB.order_costs = [];
    await loadInventory();
    await sleep(60);
    t(txt($('inventoryList')).indexOf('还没有商品') >= 0, 'T8.1 无商品时提示「' + txt($('inventoryList')) + '」');
    await loadMoves();
    await sleep(60);
    t(txt($('movesList')).indexOf('还没有出入库记录') >= 0, 'T8.2 无流水时提示「' + txt($('movesList')) + '」');
    switchTab('report');
    await sleep(120);
    t($('reportBody').innerText.indexOf('该周期还没有销售记录') >= 0, 'T8.3 报表在无销售时给出空状态提示');
    window.__DB.products = backupProducts;
    window.__DB.stock_moves = backupMoves;
    window.__DB.order_costs = backupCosts;

    /* ================= T9 订单管理页 ================= */
    const O = EXP.orders;
    const r2 = (v) => Math.round(v * 100) / 100;
    /* T6 里通过真实业务函数写入过一个订单（MOCK-TK-WRITE：2 笔出库 / 3 件 /
       成交单价 $6.99、进价 ¥2.8），所以这里的合计期望 = DB 实测基线 + 这笔写入。
       金额按新口径折算：3 件 × $6.99 × 汇率；商品成本直接是人民币。 */
    const DELTA = {
      orders: 1,
      moves: 2,
      qty: 3,
      sales: 3 * 6.99 * EXP.rate,
      cost: 3 * 2.8,
    };
    const T = {
      orders: O.total.orders + DELTA.orders,
      moves: O.total.moves + DELTA.moves,
      qty: O.total.qty + DELTA.qty,
      sales: r2(O.total.sales + DELTA.sales),
      cost: r2(O.total.cost + DELTA.cost),
      other: O.total.other,
      net: r2(O.total.sales + DELTA.sales - O.total.cost - DELTA.cost - O.total.other),
    };
    const rows = () => $('ordersList').querySelectorAll('.order-row');
    const rowTxt = (i) => txt(rows()[i]);
    const rowOf = (no) => Array.from(rows()).filter((el) => el.dataset.orderRow === no)[0];

    switchTab('orders');
    await waitFor(() => rows().length > 0);
    t($('panel-orders').classList.contains('hidden') === false && rows().length > 0,
      'T9.1 顶部导航新增「订单管理」页并可正常进入');
    t(rows().length === T.orders,
      'T9.2 左侧列出 ' + rows().length + ' 个订单（DB 实测 ' + O.total.orders + ' 个 + 本轮新写入 ' + DELTA.orders + ' 个）');
    t(txt($('ordersCount')).indexOf('共 ' + T.orders + ' 个订单') >= 0 &&
      txt($('ordersCount')).indexOf(T.moves + ' 笔出库') >= 0 &&
      txt($('ordersCount')).indexOf(T.qty + ' 件') >= 0,
      'T9.3 顶部合计：' + txt($('ordersCount')).slice(0, 30) + '…');
    const cntTxt = txt($('ordersCount'));
    t(cntTxt.indexOf(money(T.sales)) >= 0 &&
      cntTxt.indexOf(money(T.cost)) >= 0 &&
      cntTxt.indexOf(money(T.other)) >= 0 &&
      cntTxt.indexOf(money(T.net)) >= 0,
      'T9.4 合计金额 ' + money(T.sales) + ' / 商品成本 ' + money(T.cost) +
      ' / 其他成本 ' + money(T.other) + ' / 净利润 ' + money(T.net) +
      '（页面：' + cntTxt.slice(cntTxt.indexOf('金额')) + '）');
    t(rows()[0].dataset.orderRow === O.newest.no,
      'T9.5 默认按时间倒序，最新订单「' + O.newest.no + '」排在最前');
    t($('orderDetail').innerText.indexOf('从左侧选择一个订单') >= 0,
      'T9.6 未选中订单时右侧给出引导文案');

    /* 排序：按金额 */
    $('orderSortSelect').value = 'sales';
    $('orderSortSelect').dispatchEvent(new Event('change'));
    await sleep(60);
    const top = O.top_sales[0];
    t(rows()[0].dataset.orderRow === top.no,
      'T9.7 切「按金额」排序后第一位是 ' + top.no + '（DB 实测金额最高）');
    t(rowTxt(0).indexOf(money(top.sales)) >= 0 && rowTxt(0).indexOf(money(top.net)) >= 0 &&
      rowTxt(0).indexOf(money(top.cost + top.other)) >= 0,
      'T9.8 列表行展示金额 ' + money(top.sales) + ' / 成本 ' + money(top.cost + top.other) +
      ' / 净利润 ' + money(top.net));
    t(rowTxt(0).indexOf(top.buyer) >= 0 && rowTxt(0).indexOf(top.moves + ' 笔') >= 0 &&
      rowTxt(0).indexOf(top.qty + ' 件') >= 0,
      'T9.9 列表行展示客户「' + top.buyer + '」与 ' + top.moves + ' 笔 / ' + top.qty + ' 件');
    t(top.net > 0 && rows()[0].querySelector('.badge.net') !== null,
      'T9.10 盈利订单打「盈利」标签');

    $('orderSortSelect').value = 'net';
    $('orderSortSelect').dispatchEvent(new Event('change'));
    await sleep(60);
    t(rows()[0].dataset.orderRow === O.top_net.no,
      'T9.11 切「按净利润」排序后第一位是 ' + O.top_net.no + '（净利 ' + money(O.top_net.net) + '）');
    $('orderSortSelect').value = 'time';
    $('orderSortSelect').dispatchEvent(new Event('change'));
    await sleep(60);

    /* 搜索：客户 / 商品名 */
    setInput('orderSearchInput', 'Michael');
    await sleep(60);
    t(rows().length === O.search.michael,
      'T9.12 按客户搜索「Michael」命中 ' + rows().length + ' 个订单（DB 实测 ' + O.search.michael + '）');
    t(txt($('ordersCount')).indexOf('筛选出 ' + O.search.michael + ' 个订单 / 共 ' + T.orders + ' 个') >= 0,
      'T9.13 筛选时计数文案切换为「' + txt($('ordersCount')).slice(0, 24) + '…」');

    setInput('orderSearchInput', '星空夜光');
    await sleep(60);
    t(rows().length === O.search.star_product,
      'T9.14 按商品名搜索「星空夜光」命中 ' + rows().length + ' 个订单（DB 实测 ' + O.search.star_product + '）');

    setInput('orderSearchInput', 'zzz-not-exist');
    await sleep(60);
    t(txt($('ordersList')) === '没有匹配的订单', 'T9.15 搜索无结果时提示「没有匹配的订单」');

    /* 选中订单 → 右侧详情（成本利润） */
    setInput('orderSearchInput', O.star.no);
    await sleep(80);
    t(rows().length === 1, 'T9.16 搜索订单号 ' + O.star.no + ' 精确命中 1 个订单');
    rows()[0].click();
    await sleep(80);
    const det = $('orderDetail');
    const dTxt = txt(det);
    t(det.querySelector('.order-sum-card') !== null, 'T9.17 选中订单后右侧渲染订单结算卡');
    t(rows()[0].classList.contains('is-selected'), 'T9.18 被选中的订单行高亮');
    t(dTxt.indexOf(O.star.buyer) >= 0, 'T9.19 详情显示客户姓名「' + O.star.buyer + '」');
    t(dTxt.indexOf(money(O.star.sales)) >= 0, 'T9.20 详情订单金额 ' + money(O.star.sales) + '（DB 实测）');
    t(dTxt.indexOf(money(O.star.cost)) >= 0, 'T9.21 详情商品成本 ' + money(O.star.cost) + '（按商品当前进价）');
    t(dTxt.indexOf(money(O.star.other)) >= 0, 'T9.22 详情其他成本 ' + money(O.star.other) + '（已录入的整单费用）');
    t(dTxt.indexOf(money(O.star.net)) >= 0,
      'T9.23 详情净利润 ' + money(O.star.net) + ' = 金额 − 商品成本 − 其他成本');
    t(dTxt.indexOf((O.star.margin * 100).toFixed(1) + '%') >= 0,
      'T9.24 详情毛利率 ' + (O.star.margin * 100).toFixed(1) + '%');
    t(/商品明细/.test(dTxt) && dTxt.indexOf(O.star.products[0][0]) >= 0,
      'T9.25 详情列出商品明细（含「' + O.star.products[0][0] + '」）');
    const detTable = det.querySelectorAll('.report-table tbody tr');
    t(detTable.length === O.star.moves && txt(detTable[0]).indexOf(String(O.star.qty)) >= 0,
      'T9.26 明细表 ' + detTable.length + ' 行，数量 ' + O.star.qty + ' 件（DB 实测）');
    t(/修改其他成本/.test(dTxt), 'T9.27 已录其他成本时按钮文案为「修改其他成本」');

    /* 再次点击同一订单 → 收起 */
    rows()[0].click();
    await sleep(60);
    t($('orderDetail').innerText.indexOf('从左侧选择一个订单') >= 0,
      'T9.28 再次点击同一订单可收起详情');

    /* 亏损订单带「亏损」标签 */
    setInput('orderSearchInput', 'TK2026101403');
    await sleep(80);
    const lossRow = rows()[0];
    t(!!lossRow && lossRow.querySelector('.badge.loss') !== null,
      'T9.29 净利润为负的订单打「亏损」标签（' + (lossRow ? txt(lossRow).slice(0, 18) : '—') + '…）');

    /* 详情里录入其他成本 → 净利润立即重算 */
    setInput('orderSearchInput', O.o1064.no);
    await sleep(80);
    rows()[0].click();
    await sleep(80);
    let det2 = $('orderDetail');
    t(txt(det2).indexOf(money(O.o1064.net)) >= 0, 'T9.30 订单 ' + O.o1064.no + ' 详情净利 ' + money(O.o1064.net));
    det2.querySelector('[data-cost]').click();
    await sleep(60);
    $('ocCost').value = '20';
    await onModalOk();
    await sleep(120);
    const newNet = O.o1064.sales - O.o1064.cost - 20;
    t(txt($('orderDetail')).indexOf(money(newNet)) >= 0,
      'T9.31 把其他成本改成 20 元后，详情净利实时更新为 ' + money(newNet));
    t(txt(rows()[0]).indexOf(money(newNet)) >= 0, 'T9.32 列表行净利润同步更新');
    $('orderDetail').querySelector('[data-cost]').click();
    await sleep(60);
    $('ocCost').value = String(O.o1064.other);
    await onModalOk();
    await sleep(120);
    t(txt($('orderDetail')).indexOf(money(O.o1064.net)) >= 0,
      'T9.33 改回 ' + money(O.o1064.other) + ' 后净利恢复 ' + money(O.o1064.net));

    /* 「在流水页查看」联动 */
    $('orderDetail').querySelector('[data-goto-moves]').click();
    await waitFor(() => $('moveOrderFilter').textContent.indexOf(O.o1064.no) >= 0);
    await waitFor(() => $('movesList').querySelectorAll('.item').length === O.o1064.moves);
    t($('panel-moves').classList.contains('hidden') === false &&
      $('moveOrderFilter').textContent.indexOf(O.o1064.no) >= 0,
      'T9.34「在流水页查看」跳到流水页并带上该订单筛选');
    t($('movesList').querySelectorAll('.item').length === O.o1064.moves,
      'T9.35 流水页筛出该订单 ' + $('movesList').querySelectorAll('.item').length + ' 条流水（DB 实测 ' + O.o1064.moves + ' 条）');

    /* ========== 订单可修改项：发货记录 / 客户姓名 / 退回库存 ========== */
    switchTab('orders');
    await waitFor(() => rows().length > 0);
    const detailVal = (label) => {
      const boxes = Array.from($('orderDetail').querySelectorAll('.order-sum-grid > div'));
      const b = boxes.filter((x) => txt(x.querySelector('.os-label')) === label)[0];
      return b ? txt(b.querySelector('.os-value')) : null;
    };
    const o1064Outs = () => window.__DB.stock_moves
      .filter((m) => m.order_no === O.o1064.no && m.move_type === 'out');
    const outsBefore = o1064Outs();

    /* 发货记录：一个订单一条，可录可改 */
    t(txt($('orderDetail')).indexOf('还没有发货记录') >= 0, 'T9.36 详情默认显示「还没有发货记录」');
    $('orderDetail').querySelector('[data-ship]').click();
    await sleep(60);
    $('shCarrier').value = '云途物流';
    $('shShipped').value = '2026-10-10';
    $('shArrived').value = '2026-10-15';
    $('shSigned').value = '2026-10-18';
    $('shTracking').value = 'YT20261010001';
    await onModalOk();
    await sleep(150);
    const dTxtShip = txt($('orderDetail'));
    t(dTxtShip.indexOf('云途物流') >= 0 && dTxtShip.indexOf('YT20261010001') >= 0 &&
      dTxtShip.indexOf('2026-10-10') >= 0 && dTxtShip.indexOf('2026-10-18') >= 0,
      'T9.37 发货记录展示物流商 / 发货日期 / 到仓时间 / 签收时间 / 国际单号');
    t(window.__DB.order_shipments.length === 1 &&
      window.__DB.order_shipments[0].order_no === O.o1064.no,
      'T9.38 发货记录落库到 order_shipments（一个订单一条）');

    $('orderDetail').querySelector('[data-ship]').click();
    await sleep(60);
    $('shCarrier').value = '燕文物流';
    await onModalOk();
    await sleep(150);
    t(txt($('orderDetail')).indexOf('燕文物流') >= 0 && window.__DB.order_shipments.length === 1,
      'T9.39 再次保存是修改同一条发货记录，不会新增');

    /* 修改客户姓名：同步该订单全部出库流水 */
    $('orderDetail').querySelector('[data-edit-buyer]').click();
    await sleep(60);
    $('obName').value = 'Amelia Brooks Jr';
    await onModalOk();
    await sleep(200);
    t(txt($('orderDetail')).indexOf('Amelia Brooks Jr') >= 0, 'T9.40 改客户姓名后详情立即更新');
    t(o1064Outs().every((m) => m.buyer_name === 'Amelia Brooks Jr'),
      'T9.41 客户姓名同步到该订单全部出库流水（' + o1064Outs().length + ' 笔）');

    /* 摊销：退回库存，冲减本单金额与利润 */
    const firstPid = outsBefore[0].product_id;
    const pOuts = outsBefore.filter((m) => m.product_id === firstPid);
    const lastPrice = Number(pOuts[pOuts.length - 1].unit_price);
    const prodRow = window.__DB.products.filter((p) => p.id === firstPid)[0];
    const stockBeforeRet = Number(prodRow.stock);
    const unitCost = Number(prodRow.cost_price) || 0;

    const retBtn = $('orderDetail').querySelector('[data-return]');
    t(!!retBtn, 'T9.42 商品行提供「退回库存」按钮');
    retBtn.click();
    await sleep(80);
    $('rqQty').value = '1';
    await onModalOk();
    await sleep(250);

    const retMove = window.__DB.stock_moves[window.__DB.stock_moves.length - 1];
    t(retMove.move_type === 'in' && retMove.is_return === true &&
      retMove.order_no === O.o1064.no && Number(retMove.quantity) === 1,
      'T9.43 退回生成 is_return 入库流水并挂在原订单号下');
    t(Number(prodRow.stock) === stockBeforeRet + 1,
      'T9.44 退回 1 件后商品库存 ' + stockBeforeRet + ' → ' + prodRow.stock);
    t(near(detailVal('订单金额'), O.o1064.sales - lastPrice * EXP.rate),
      'T9.45 订单金额冲减为 ' + detailVal('订单金额') + '（原 ' + money(O.o1064.sales) +
      ' − 1 件 × $' + lastPrice.toFixed(2) + ' × ' + EXP.rate + '）');
    t(near(detailVal('商品成本'), O.o1064.cost - unitCost),
      'T9.46 商品成本同步冲减为 ' + detailVal('商品成本'));
    t($('orderDetail').querySelectorAll('tr.is-return').length === 1,
      'T9.47 明细里出现一条负数的退货行');
    t(txt($('orderDetail')).indexOf('已退回 1 件') >= 0,
      'T9.48 退回区块标记该商品「已退回 1 件」');

    /* ================= T10 商品建档 · 进货渠道 / 进货商 ================= */
    /* 这一段会真的往 mock 库里写入一款商品用于验证，跑完立刻还原，
       避免影响前面已断言过的商品数与聚合结果 */
    const bkP = window.__DB.products;
    const bkM = window.__DB.stock_moves;
    window.__DB.products = bkP.map((p) => Object.assign({}, p));
    window.__DB.stock_moves = bkM.map((m) => Object.assign({}, m));

    switchTab('create');
    await sleep(80);
    t(!!$('fChannel') && !!$('fSupplier') &&
      txt($('fChannel').closest('.field')).indexOf('进货渠道') >= 0 &&
      txt($('fSupplier').closest('.field')).indexOf('进货商名称') >= 0,
      'T10.1 建档表单新增「进货渠道」「进货商名称」两个字段');

    /* 造一张真图拖进上传框，走完整的建档链路 */
    const dt10 = new DataTransfer();
    const blob10 = await new Promise((res) => {
      const c = document.createElement('canvas');
      c.width = 60; c.height = 60;
      const g = c.getContext('2d');
      g.fillStyle = '#16a34a'; g.fillRect(0, 0, 60, 60);
      c.toBlob(res, 'image/png');
    });
    dt10.items.add(new File([blob10], 't10.png', { type: 'image/png' }));
    $('uploadZone').dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt10,
    }));
    await sleep(350);
    t(!$('previewImg').classList.contains('hidden'), 'T10.2 建档页照片已就绪');

    const n10 = window.__DB.products.length;
    $('fName').value = '【测试】进货渠道贴纸';
    $('fBrand').value = 'T10测试品牌';
    $('fChannel').value = '1688 批发';
    $('fSupplier').value = '义乌星辰日用百货';
    $('fCost').value = '3.5';
    $('fStock').value = '7';
    $('saveProductBtn').click();
    await waitFor(() => window.__DB.products.length === n10 + 1, 3000);
    const np10 = window.__DB.products[window.__DB.products.length - 1];
    t(!!np10 && np10.purchase_channel === '1688 批发' && np10.supplier_name === '义乌星辰日用百货',
      'T10.3 建档落库：进货渠道「' + (np10 && np10.purchase_channel) +
      '」/ 进货商「' + (np10 && np10.supplier_name) + '」');
    t(!!np10 && Number(np10.cost_price) === 3.5 && Number(np10.stock) === 7,
      'T10.4 建档同批写入进价 ¥3.50 与初始库存 7 件');
    t($('fChannel').value === '' && $('fSupplier').value === '',
      'T10.5 建档成功后表单被重置，两个新字段一并清空');

    switchTab('inventory');
    await waitFor(() => Array.from(items()).some((el) => txt(el).indexOf('进货渠道贴纸') >= 0));
    const card10 = Array.from(items()).filter((el) => txt(el).indexOf('进货渠道贴纸') >= 0)[0];
    t(!!card10 && txt(card10).indexOf('渠道 1688 批发') >= 0 &&
      txt(card10).indexOf('进货商 义乌星辰日用百货') >= 0,
      'T10.6 商品卡片显示进货渠道与进货商');

    const cardPlain = Array.from(items()).filter((el) => txt(el).indexOf('MK20261014001') >= 0)[0];
    const srcLine = cardPlain ? txt(cardPlain.querySelector('.item-source')).trim() : '';
    t(srcLine.indexOf('进货 —') >= 0,
      'T10.7 未登记进货信息的商品显示「' + srcLine + '」');

    card10.querySelector('[data-act="edit"]').click();
    await sleep(120);
    t($('eChannel').value === '1688 批发' && $('eSupplier').value === '义乌星辰日用百货',
      'T10.8 编辑弹窗回填已登记的进货渠道 / 进货商');
    $('eChannel').value = '拼多多';
    $('eSupplier').value = '';
    await onModalOk();
    await sleep(300);
    const np10b = window.__DB.products.filter((p) => p.id === np10.id)[0];
    t(!!np10b && np10b.purchase_channel === '拼多多' && np10b.supplier_name === null,
      'T10.9 编辑保存落库（渠道 → 拼多多，进货商清空为 null）');

    /* 还原：把这一段的写入整体撤掉 */
    window.__DB.products = bkP;
    window.__DB.stock_moves = bkM;
    switchTab('inventory');
    await sleep(120);
    setInput('searchInput', '');
    brandBtn('__all__').click();
    await waitFor(() => items().length > 0);
    t(items().length === EXP.products_total,
      'T10.10 测试写入已还原，库存页回到 ' + items().length + ' 款（不影响既有数据）');

    return { ok, fail };
  }, { FX: FIX, EXP, SHOT: SHOT_DIR });

  /* ---------------- 截图：重新驱动一遍界面，留下真实画面 ---------------- */
  try {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await page.evaluate((FX) => { window.__installMockCloud(FX); return enterApp(); }, FIX);
    await page.waitForTimeout(300);
    await page.evaluate(() => switchTab('inventory'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: SHOT_DIR + '/01-inventory.png' });

    await page.evaluate(() => switchTab('moves'));
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      setMoveOrderFilter('MOCK-TK2026101064');
    });
    await page.waitForTimeout(900);
    await page.screenshot({ path: SHOT_DIR + '/02-moves-order.png' });

    await page.evaluate(() => switchTab('report'));
    await page.waitForTimeout(900);
    await page.screenshot({ path: SHOT_DIR + '/03-report-day.png', fullPage: true });

    await page.evaluate(() => {
      document.getElementById('reportModeSeg').querySelector('[data-mode="month"]').click();
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: SHOT_DIR + '/04-report-month.png', fullPage: true });

    /* ---- 新功能实拍：发货记录 / 退回库存 / 流水类型筛选 / 汇率 ---- */
    const shot = async (name, full) => {
      await page.screenshot({ path: SHOT_DIR + '/' + name, fullPage: !!full });
    };

    await page.evaluate(() => switchTab('orders'));
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const inp = document.getElementById('orderSearchInput');
      inp.value = 'MOCK-TK2026101064';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const r = document.querySelectorAll('#ordersList .order-row');
      if (r[0]) r[0].click();
    });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const b = document.querySelector('#orderDetail [data-ship]');
      if (b) b.click();
    });
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      document.getElementById('shCarrier').value = '云途物流 YunExpress';
      document.getElementById('shShipped').value = '2026-10-10';
      document.getElementById('shArrived').value = '2026-10-15';
      document.getElementById('shSigned').value = '2026-10-18';
      document.getElementById('shTracking').value = 'YT2026101000088';
      document.getElementById('modalOk').click();
    });
    await page.waitForTimeout(800);
    await shot('14-order-shipment.png', true);

    await page.evaluate(() => {
      const b = document.querySelector('#orderDetail [data-return]');
      if (b) b.click();
    });
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      const q = document.getElementById('rqQty');
      if (q) q.value = '1';
      document.getElementById('modalOk').click();
    });
    await page.waitForTimeout(900);
    await shot('15-order-return.png', true);

    await page.evaluate(() => { switchTab('moves'); clearMoveFilter(); });
    await page.waitForTimeout(600);
    await page.evaluate(() => setMoveKind('out'));
    await page.waitForTimeout(800);
    await shot('16-moves-kind-out.png', false);

    await page.evaluate(() => document.getElementById('rateBtn').click());
    await page.waitForTimeout(400);
    await shot('17-rate-dialog.png', false);

    /* 商品建档：把照片拖进上传框 */
    await page.evaluate(() => {
      document.getElementById('modalCancel').click();
      switchTab('create');
    });
    await page.waitForTimeout(500);
    await page.evaluate(async () => {
      const zone = document.getElementById('uploadZone');
      const dt = new DataTransfer();
      const c = document.createElement('canvas');
      c.width = 80; c.height = 80;
      const g = c.getContext('2d');
      g.fillStyle = '#4f46e5'; g.fillRect(0, 0, 80, 80);
      g.fillStyle = '#fff'; g.fillRect(24, 24, 32, 32);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      dt.items.add(new File([blob], 'drop-product.png', { type: 'image/png' }));
      ['dragenter', 'dragover'].forEach((type) => zone.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })));
      window.__dropDt = dt;
    });
    await page.waitForTimeout(500);
    await shot('18-create-dragover.png', false);

    await page.evaluate(() => {
      const zone = document.getElementById('uploadZone');
      zone.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: window.__dropDt,
      }));
    });
    await page.waitForTimeout(700);
    await shot('19-create-dropped.png', false);

    /* ---- 进货渠道 / 进货商：建档核对卡片与商品卡片 ---- */
    await page.evaluate(() => {
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      set('fCode', 'SP20261016001');
      set('fName', '星空夜光贴纸套装');
      set('fBrand', '纸间集');
      set('fOrigin', '浙江义乌');
      set('fMaterial', 'PVC 不干胶');
      set('fSpec', '20 张 / 包');
      set('fStandard', 'GB 6675-2014');
      set('fChannel', '1688 批发');
      set('fSupplier', '义乌星辰日用百货');
      set('fCost', '3.50');
      set('fSale', '6.99');
      set('fStock', '30');
      const card = document.getElementById('reviewCard');
      card.classList.remove('hidden');
      card.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(500);
    await shot('20-create-supplier.png', false);

    /* 商品卡片上的进货信息（截图会话内的 mock 数据，仅用于展示） */
    await page.evaluate(() => {
      const p = window.__DB.products.filter((x) => x.code === 'MK20261014001')[0];
      if (p) { p.purchase_channel = '1688 批发'; p.supplier_name = '义乌星辰日用百货'; }
      switchTab('inventory');
    });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('#inventoryList .item'))
        .filter((el) => el.innerText.indexOf('MK20261014001') >= 0)[0];
      if (card) card.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(400);
    await shot('21-inventory-supplier.png', false);
  } catch (e) {
    console.log('截图阶段异常：' + e.message);
  }

  console.log('');
  R.ok.forEach((m) => console.log('  \u2713 ' + m));
  if (R.fail.length) {
    console.log('');
    R.fail.forEach((m) => console.log('  \u2717 ' + m));
  }
  console.log('');
  console.log('========================================');
  console.log('通过 ' + R.ok.length + ' / ' + (R.ok.length + R.fail.length));
  console.log('页面 JS 异常：' + (pageErrors.length ? pageErrors.join(' | ') : '无 ✓'));
  console.log('控制台 error：' + (consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '无 ✓'));
  console.log('========================================');

  fs.writeFileSync('/tmp/mock/test-result.json', JSON.stringify({
    ok: R.ok, fail: R.fail, pageErrors, consoleErrors,
  }, null, 2));

  await browser.close();
  process.exit(R.fail.length ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(2);
});
