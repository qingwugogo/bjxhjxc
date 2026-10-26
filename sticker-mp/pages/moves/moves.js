const app = getApp();
const db = require('../../utils/db');
const { fmtMoney, fmtUsd, fmtTime } = require('../../utils/format');
const { describeDbError } = require('../../utils/errors');
const { buildOrderStats, orderCardView } = require('../../utils/stats');

const ORDER_MOVES_LIMIT = 1000;
const ORDER_CARDS_MAX = 20;

Page({
  data: {
    ready: false,
    loginError: '',
    loggedOut: false,
    rateText: '7.20',
    loading: true,
    kind: 'all',
    buyerKw: '',
    productKw: '',
    orderFilter: '',
    list: [],
    countText: '',
    emptyText: '还没有出入库记录',
    summary: { show: false, lead: '', cards: [] },
    dialog: { show: false, title: '', note: '', fields: [], error: '', busy: false, submitText: '确定' },
  },

  onLoad() {
    this.init();
  },

  onShow() {
    if (!this.data.ready) return;
    const pending = app.globalData.pendingMoveFilter;
    if (pending) {
      app.globalData.pendingMoveFilter = '';
      this.setData({ orderFilter: pending });
    }
    this.loadMoves();
  },

  onPullDownRefresh() {
    this.loadMoves().then(() => wx.stopPullDownRefresh());
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
    await this.loadMoves();
  },

  retry() {
    this.setData({ loginError: '', loggedOut: false, ready: false });
    app.retryLogin().then(() => this.init()).catch(() => {
      this.setData({ loginError: app.globalData.loginError || '登录失败，请重试', loggedOut: !!app.globalData.loggedOut });
    });
  },

  onRateChange(e) {
    this.setData({ rateText: Number(e.detail.rate).toFixed(2) });
    /* 汇率变了，订单结算卡的金额要跟着重算 */
    if (this.data.orderFilter && this.summaryRows) {
      this.renderSummary();
    }
  },

  async loadMoves() {
    this.setData({ loading: true });
    const costsPromise = db.listOrderCosts();
    try {
      const res = await db.listMoves(200);
      if (res.error) {
        this.setData({ loading: false, list: [], countText: describeDbError(res.error) });
        return;
      }
      this.moves = Array.isArray(res.data) ? res.data : [];
      this.costs = await costsPromise;
      this.setData({ loading: false });
      this.render();
      this.scheduleSummary(this.data.orderFilter);
    } catch (err) {
      this.setData({ loading: false, list: [], countText: '加载失败，请重试' });
    }
  },

  render() {
    const { kind, buyerKw, productKw, orderFilter } = this.data;
    const buyer = String(buyerKw || '').trim().toLowerCase();
    const product = String(productKw || '').trim().toLowerCase();
    const order = String(orderFilter || '').trim().toLowerCase();
    const filtered = !!(buyer || product || order || kind !== 'all');

    const rows = (this.moves || []).filter((m) => {
      const p = m.product || {};
      if (kind === 'in' && m.move_type !== 'in') return false;
      if (kind === 'out' && m.move_type !== 'out') return false;
      if (buyer) {
        if (String(m.buyer_name == null ? '' : m.buyer_name).toLowerCase().indexOf(buyer) < 0) return false;
      }
      if (product) {
        const text = [p.name, p.code].map((v) => String(v == null ? '' : v)).join(' ').toLowerCase();
        if (text.indexOf(product) < 0) return false;
      }
      if (order) {
        if (String(m.order_no == null ? '' : m.order_no).toLowerCase().indexOf(order) < 0) return false;
      }
      return true;
    });

    const list = rows.map((m) => {
      const isOut = m.move_type === 'out';
      const isReturn = !!m.is_return;
      const p = m.product || {};
      const buyerText = [m.buyer_name, m.buyer_phone, m.buyer_addr].filter(Boolean).join(' · ');
      return {
        id: m.id,
        name: p.name || '（商品已删除）',
        isReturn,
        badgeText: isReturn ? '退货入库' : (isOut ? '出库' : '入库'),
        badgeCls: isReturn ? 'badge-ret' : (isOut ? 'badge-sale' : 'badge-in'),
        qtyText: (isOut ? '-' : '+') + m.quantity,
        priceText: isOut ? fmtUsd(m.unit_price) : fmtMoney(m.unit_price),
        timeText: fmtTime(m.created_at),
        orderNo: m.order_no || '',
        showOrder: !!(isOut || m.order_no),
        buyerText: buyerText || '未填写',
        noteText: m.buyer_note || '',
      };
    });

    const total = (this.moves || []).length;
    const countText = total === 0
      ? ''
      : (filtered ? '筛选出 ' + list.length + ' 条 / 共 ' + total + ' 条' : '共 ' + total + ' 条记录');

    this.setData({
      list,
      countText,
      emptyText: filtered ? '没有匹配的流水记录' : '还没有出入库记录',
    });
  },

  setKind(e) {
    const kind = e.currentTarget.dataset.kind;
    if (kind === this.data.kind) return;
    this.setData({ kind });
    this.render();
  },

  onBuyerInput(e) {
    this.setData({ buyerKw: e.detail.value });
    this.render();
  },

  onProductInput(e) {
    this.setData({ productKw: e.detail.value });
    this.render();
  },

  clickOrderChip(e) {
    const no = e.currentTarget.dataset.no;
    if (!no) return;
    this.setData({ orderFilter: no });
    this.render();
    this.scheduleSummary(no);
  },

  clearOrderFilter() {
    this.setData({ orderFilter: '' });
    this.render();
    this.scheduleSummary('');
  },

  clearFilters() {
    this.setData({ buyerKw: '', productKw: '', orderFilter: '', kind: 'all' });
    this.render();
    this.scheduleSummary('');
  },

  refresh() {
    this.loadMoves();
    wx.showToast({ title: '已刷新', icon: 'none' });
  },

  /* ---------- 订单结算卡 ---------- */

  scheduleSummary(kw) {
    clearTimeout(this._summaryTimer);
    if (!kw) {
      this.summaryRows = null;
      this.setData({ summary: { show: false, lead: '', cards: [] } });
      return;
    }
    this.setData({ summary: { show: true, lead: '正在结算订单…', cards: [] } });
    this._summaryTimer = setTimeout(() => this.loadSummary(kw), 350);
  },

  async loadSummary(kw) {
    try {
      const res = await db.listOrderMoves(kw, { limit: ORDER_MOVES_LIMIT, ascending: true });
      if (res.error) {
        this.setData({ summary: { show: true, lead: '订单结算查询失败：' + describeDbError(res.error), cards: [] } });
        return;
      }
      this.summaryRows = Array.isArray(res.data) ? res.data : [];
      this.renderSummary();
    } catch (err) {
      this.setData({ summary: { show: true, lead: '订单结算查询失败，请重试', cards: [] } });
    }
  },

  renderSummary() {
    const kw = this.data.orderFilter;
    const { list, total, skippedIn } = buildOrderStats(this.summaryRows || [], kw, {
      rate: app.globalData.rate,
      costs: this.costs || new Map(),
    });

    if (list.length === 0) {
      this.setData({ summary: { show: true, lead: '该订单还没有出库记录，无法结算（入库不计入订单金额）', cards: [] } });
      return;
    }

    const lead = [];
    lead.push(list.length === 1 ? '订单结算' : '命中 ' + total.orders + ' 个订单');
    lead.push('金额 ' + fmtMoney(total.sales) + '（' + fmtUsd(total.salesUsd) + ' × ' +
      Number(app.globalData.rate).toFixed(2) + '）' +
      ' · 成本 ' + fmtMoney(total.cost + total.otherCost) +
      ' · 净利润 ' + fmtMoney(total.net));
    if (list.length > ORDER_CARDS_MAX) lead.push('仅展示金额前 ' + ORDER_CARDS_MAX + ' 个');
    if (skippedIn > 0) lead.push('另有 ' + skippedIn + ' 笔入库未计入');

    const cards = list.slice(0, ORDER_CARDS_MAX).map((r) => orderCardView(r));
    this.setData({ summary: { show: true, lead: lead.join(' · '), cards } });
  },

  /* ---------- 其他成本 ---------- */

  openCost(e) {
    const no = (e.detail && e.detail.orderNo) || e.currentTarget.dataset.no;
    const cur = (this.costs && this.costs.get(String(no))) || { other_cost: 0, cost_note: '' };
    this.costOrderNo = no;
    this.setData({
      dialog: {
        show: true,
        title: '订单其他成本 · ' + no,
        note: '这里填除商品进价之外的整单费用，比如运费、平台佣金、包装费。保存后自动从利润里扣掉。',
        error: '',
        busy: false,
        submitText: '保存',
        fields: [
          { key: 'other_cost', label: '其他成本（元）', type: 'digit', value: String(cur.other_cost || 0) },
          { key: 'cost_note', label: '费用说明（选填）', type: 'text', value: cur.cost_note || '', placeholder: '例如：运费 5 + 平台佣金 2' },
        ],
      },
    });
  },

  closeDialog() {
    this.setData({ 'dialog.show': false });
  },

  async submitCost(e) {
    const values = e.detail.values || {};
    const raw = String(values.other_cost == null ? '' : values.other_cost).trim();
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || value < 0) {
      this.setData({ 'dialog.error': '请填写不小于 0 的金额' });
      return;
    }
    this.setData({ 'dialog.busy': true, 'dialog.error': '' });
    try {
      const res = await db.saveOrderCost(this.costOrderNo, value, String(values.cost_note || '').trim());
      if (res.error) {
        this.setData({ 'dialog.error': describeDbError(res.error), 'dialog.busy': false });
        return;
      }
      if (!this.costs) this.costs = new Map();
      this.costs.set(String(this.costOrderNo), {
        other_cost: value,
        cost_note: String(values.cost_note || '').trim(),
      });
      this.setData({ 'dialog.show': false, 'dialog.busy': false });
      wx.showToast({ title: '已保存其他成本', icon: 'success' });
      this.renderSummary();
    } catch (err) {
      this.setData({ 'dialog.error': (err && err.message) || '保存失败，请重试', 'dialog.busy': false });
    }
  },
});
