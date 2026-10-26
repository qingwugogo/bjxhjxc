const app = getApp();
const { cloud } = require('../../utils/cloud');
const { fmtMoney, fmtMargin, marginOf } = require('../../utils/format');
const { describeDbError } = require('../../utils/errors');
const { aggregateReport, reportRangeText, reportPeriodName } = require('../../utils/stats');

const REPORT_LIMIT = 3000;
const COLS = 'quantity, unit_price, created_at, product_id, move_type, is_return, ' +
  'product:products(id, name, code, cost_price)';

/* 当前选择对应的查询区间（左闭右开，用本地时间构造再转 ISO） */
function reportRange(mode, year, month) {
  if (mode === 'year') return { from: null, to: null };
  if (mode === 'month') return { from: new Date(year, 0, 1), to: new Date(year + 1, 0, 1) };
  return { from: new Date(year, month - 1, 1), to: new Date(year, month, 1) };
}

Page({
  data: {
    ready: false,
    loginError: '',
    loggedOut: false,
    rateText: '7.20',
    mode: 'day',
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    yearIndex: 0,
    years: [],
    months: [],
    rangeText: '',
    periodName: '日期',
    loading: true,
    cards: [],
    chart: { max: 0, bars: [] },
    rank: [],
    table: [],
  },

  onLoad() {
    this.init();
  },

  onShow() {
    if (this.data.ready) this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async init() {
    try {
      await app.waitReady();
    } catch (err) {
      this.setData({ loginError: app.globalData.loginError || '登录失败，请重试', loggedOut: !!app.globalData.loggedOut });
      return;
    }
    this.setData({
      ready: true,
      loginError: '',
      loggedOut: false,
      rateText: Number(app.globalData.rate).toFixed(2),
    });
    await this.ensureEarliestYear();
    this.syncSelectors();
    await this.load();
  },

  retry() {
    this.setData({ loginError: '', loggedOut: false, ready: false });
    app.retryLogin().then(() => this.init()).catch(() => {
      this.setData({ loginError: app.globalData.loginError || '登录失败，请重试', loggedOut: !!app.globalData.loggedOut });
    });
  },

  onRateChange(e) {
    this.setData({ rateText: Number(e.detail.rate).toFixed(2) });
    this.render();
  },

  /* 取最早一笔出库的年份，用于「按年」视图的年份范围 */
  async ensureEarliestYear() {
    if (this.earliestYear != null) return;
    try {
      const res = await cloud.database
        .from('stock_moves')
        .select('created_at')
        .eq('move_type', 'out')
        .order('created_at', { ascending: true })
        .limit(1);
      const row = Array.isArray(res.data) ? res.data[0] : null;
      if (row && row.created_at) {
        const d = new Date(row.created_at);
        if (!Number.isNaN(d.getTime())) this.earliestYear = d.getFullYear();
      }
    } catch (e) { /* 取不到就按当前年份处理 */ }
    if (this.earliestYear == null) this.earliestYear = new Date().getFullYear();
  },

  syncSelectors() {
    const current = new Date().getFullYear();
    const start = Math.min(this.earliestYear == null ? current : this.earliestYear, current);
    const years = [];
    for (let y = current; y >= start; y--) years.push({ label: y + ' 年', value: y });
    const months = [];
    for (let m = 1; m <= 12; m++) months.push({ label: m + ' 月', value: m });
    const index = Math.max(0, years.findIndex((y) => y.value === this.data.year));

    this.setData({
      years,
      months,
      yearIndex: index,
      year: years.length ? years[index].value : current,
      yearLabel: years.length ? years[index].label : '',
    });
  },

  setMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode || !mode) return;
    this.setData({ mode });
    this.load();
  },

  onYearChange(e) {
    const idx = Number(e.detail.value) || 0;
    const y = this.data.years[idx];
    if (!y) return;
    this.setData({ yearIndex: idx, year: y.value, yearLabel: y.label });
    this.load();
  },

  onMonthChange(e) {
    const idx = Number(e.detail.value) || 0;
    const m = this.data.months[idx];
    if (!m) return;
    this.setData({ month: m.value });
    this.load();
  },

  refresh() {
    this.load();
    wx.showToast({ title: '已刷新', icon: 'none' });
  },

  async load() {
    this.setData({ loading: true });
    const { mode, year, month } = this.data;
    const range = reportRange(mode, year, month);

    let outQuery = cloud.database.from('stock_moves').select(COLS).eq('move_type', 'out');
    let retQuery = cloud.database.from('stock_moves').select(COLS)
      .eq('move_type', 'in').eq('is_return', true);
    if (range.from) {
      outQuery = outQuery.gte('created_at', range.from.toISOString());
      retQuery = retQuery.gte('created_at', range.from.toISOString());
    }
    if (range.to) {
      outQuery = outQuery.lt('created_at', range.to.toISOString());
      retQuery = retQuery.lt('created_at', range.to.toISOString());
    }

    try {
      const [outRes, retRes] = await Promise.all([
        outQuery.order('created_at', { ascending: false }).limit(REPORT_LIMIT),
        retQuery.order('created_at', { ascending: false }).limit(REPORT_LIMIT),
      ]);
      if (outRes.error) {
        this.setData({ loading: false, cards: [], chart: { max: 0, bars: [] }, rank: [], table: [] });
        wx.showToast({ title: describeDbError(outRes.error), icon: 'none' });
        return;
      }
      const outs = Array.isArray(outRes.data) ? outRes.data : [];
      const rets = (retRes && !retRes.error && Array.isArray(retRes.data)) ? retRes.data : [];
      this.rows = outs.concat(rets);
      this.setData({ loading: false });
      this.render();
      if (outs.length >= REPORT_LIMIT) {
        wx.showToast({ title: '数据较多，仅统计最近 ' + REPORT_LIMIT + ' 笔', icon: 'none' });
      }
    } catch (err) {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
  },

  render() {
    const { mode, year, month } = this.data;
    this.setData({
      rangeText: reportRangeText(mode, year, month),
      periodName: reportPeriodName(mode),
      rateText: Number(app.globalData.rate).toFixed(2),
    });

    const { list, products, total } = aggregateReport(this.rows || [], {
      mode,
      year,
      month,
      earliestYear: this.earliestYear,
      rate: app.globalData.rate,
    });

    /* 五张合计卡 */
    const profitNotes = [];
    if (total.orphan > 0) profitNotes.push(total.orphan + ' 笔商品已删除，未计入');
    if (total.zeroCost > 0) profitNotes.push(total.zeroCost + ' 笔商品未填进价，偏高');
    if (total.returns > 0) profitNotes.push(total.returns + ' 笔退货已冲减');

    const cards = [
      { label: '销售额', value: fmtMoney(total.sales), note: '成交价按 $1≈¥' + Number(app.globalData.rate).toFixed(2) + ' 折算' },
      { label: '销售件数', value: total.qty + ' 件', note: '' },
      { label: '出库笔数', value: total.orders + ' 笔', note: '' },
      { label: '估算毛利', value: fmtMoney(total.profit), note: profitNotes.length ? profitNotes.join('；') : '按商品当前进价估算' },
      { label: '毛利率', value: fmtMargin(marginOf(total.sales, total.profit)), note: '估算毛利 ÷ 销售额' },
    ];

    /* 柱状图 */
    const max = list.reduce((m, b) => Math.max(m, b.sales), 0);
    const step = list.length > 14 ? Math.ceil(list.length / 10) : 1;
    const bars = list.map((b, i) => ({
      key: b.key,
      h: b.sales > 0 ? Math.max(2, (b.sales / (max || 1)) * 100) : 0,
      label: (i % step === 0 || i === list.length - 1) ? b.label : '',
    }));

    /* 商品排行（前 10） */
    const top = products.slice(0, 10);
    const topMax = top.length ? (top[0].sales || 1) : 1;
    const rank = top.map((p, i) => ({
      key: p.code + '#' + i,
      no: i + 1,
      name: p.name,
      value: fmtMoney(p.sales),
      width: Math.max(2, (p.sales / topMax) * 100),
      meta: '售出 ' + p.qty + ' 件' + (p.code ? ' · ' + p.code : '') +
        ' · 毛利率 ' + fmtMargin(marginOf(p.sales, p.profit)),
    }));

    /* 明细表：最近的在上面 */
    const table = list.slice().reverse().map((b) => ({
      key: b.key,
      full: b.full,
      sales: fmtMoney(b.sales),
      qty: b.qty,
      orders: b.orders,
      profit: fmtMoney(b.profit),
      margin: fmtMargin(marginOf(b.sales, b.profit)),
      isEmpty: b.orders === 0,
    }));

    this.setData({
      cards,
      chart: { max, bars, empty: max <= 0 },
      rank,
      table,
    });
  },
});
