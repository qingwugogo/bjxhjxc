const app = getApp();
const db = require('../../utils/db');
const { fmtMoney, fmtRange } = require('../../utils/format');
const { describeDbError } = require('../../utils/errors');
const { buildOrderStats } = require('../../utils/stats');

const ORDERS_LIMIT = 2000;

Page({
  data: {
    ready: false,
    loginError: '',
    loggedOut: false,
    rateText: '7.20',
    loading: true,
    keyword: '',
    sort: 'time',
    sortLabels: ['按时间（最新）', '按金额（高 → 低）', '按净利润（高 → 低）'],
    sortLabel: '按时间（最新）',
    list: [],
    countText: '',
    emptyText: '还没有带订单号的出库记录',
    summary: null,
  },

  onLoad() {
    this.init();
  },

  onShow() {
    /* 详情页里可能改了客户 / 退货 / 成本，回到列表要重新算 */
    if (this.data.ready) this.loadOrders();
  },

  onPullDownRefresh() {
    this.loadOrders().then(() => wx.stopPullDownRefresh());
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
    await this.loadOrders();
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

  async loadOrders() {
    this.setData({ loading: true });
    try {
      const costsPromise = db.listOrderCosts();
      const { data, error } = await db.listAllOrderMoves(ORDERS_LIMIT);
      if (error) {
        this.setData({ loading: false, list: [], countText: describeDbError(error) });
        return;
      }
      this.costs = await costsPromise;
      this.rows = (Array.isArray(data) ? data : [])
        .filter((m) => String(m.order_no == null ? '' : m.order_no).trim() !== '');
      this.setData({ loading: false });
      this.render();
    } catch (err) {
      this.setData({ loading: false, list: [], countText: '加载失败，请重试' });
    }
  },

  render() {
    const { list: all, total } = buildOrderStats(this.rows || [], '', {
      rate: app.globalData.rate,
      costs: this.costs || new Map(),
    });

    const kw = String(this.data.keyword || '').trim().toLowerCase();
    let rows = all;
    if (kw) {
      rows = rows.filter((r) => {
        const hay = [r.order_no, r.buyer, r.lastBuyer]
          .concat((r.productList || []).map((p) => p.name))
          .join(' ').toLowerCase();
        return hay.indexOf(kw) >= 0;
      });
    }

    const sorters = {
      time: (a, b) => (b.lastAt || 0) - (a.lastAt || 0),
      sales: (a, b) => b.sales - a.sales,
      net: (a, b) => b.net - a.net,
    };
    rows = rows.slice().sort(sorters[this.data.sort] || sorters.time);

    const list = rows.map((r) => ({
      orderNo: r.order_no,
      buyerText: r.buyer || '未填写',
      moves: r.moves,
      qty: r.qty,
      salesText: fmtMoney(r.sales),
      costText: fmtMoney(r.cost + r.otherCost),
      netText: fmtMoney(r.net),
      netClass: r.net > 0 ? 'is-net' : (r.net < 0 ? 'is-loss' : ''),
      flagText: r.net > 0 ? '盈利' : (r.net < 0 ? '亏损' : ''),
      flagCls: r.net > 0 ? 'badge-net' : (r.net < 0 ? 'badge-loss' : ''),
      range: fmtRange(r.firstAt, r.lastAt),
    }));

    const shown = rows.reduce((t, r) => ({
      orders: t.orders + 1,
      moves: t.moves + r.moves,
      qty: t.qty + r.qty,
      sales: t.sales + r.sales,
      cost: t.cost + r.cost,
      otherCost: t.otherCost + r.otherCost,
      net: t.net + r.net,
    }), { orders: 0, moves: 0, qty: 0, sales: 0, cost: 0, otherCost: 0, net: 0 });

    let countText = '';
    if (total.orders > 0) {
      const tail = '金额 ' + fmtMoney(shown.sales) +
        ' · 商品成本 ' + fmtMoney(shown.cost) +
        ' · 其他成本 ' + fmtMoney(shown.otherCost) +
        ' · 净利润 ' + fmtMoney(shown.net);
      countText = kw
        ? '筛选出 ' + shown.orders + ' 个订单 / 共 ' + total.orders + ' 个 · ' + tail
        : '共 ' + shown.orders + ' 个订单 · ' + shown.moves + ' 笔出库 · ' + shown.qty + ' 件 · ' + tail;
    }

    this.setData({
      list,
      countText,
      loading: false,
      emptyText: (this.rows || []).length === 0
        ? '还没有带订单号的出库记录：在库存页填订单 ID 点「开始出库」后，这里就会出现'
        : '没有匹配的订单',
    });
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
    this.render();
  },

  onSortChange(e) {
    const idx = Number(e.detail.value) || 0;
    const keys = ['time', 'sales', 'net'];
    this.setData({
      sort: keys[idx] || 'time',
      sortLabel: this.data.sortLabels[idx] || this.data.sortLabels[0],
    });
    this.render();
  },

  refresh() {
    this.loadOrders();
    wx.showToast({ title: '已刷新', icon: 'none' });
  },

  openDetail(e) {
    const no = e.currentTarget.dataset.no;
    if (!no) return;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?no=' + encodeURIComponent(no) });
  },
});
