const app = getApp();
const db = require('../../utils/db');
const { fmtUsd, fmtMoney, fmtTime } = require('../../utils/format');
const { describeDbError } = require('../../utils/errors');

/* 查重：客户姓名 + 商品名称 → 该客户是否买过这件商品。
   口径与订单统计一致：只算出库，退货（is_return 入库）冲减；
   姓名走服务端模糊匹配，商品名在本地按「名称 / 编码」过滤。 */

Page({
  data: {
    ready: false,
    loginError: '',
    loggedOut: false,
    rateText: '7.20',
    buyer: '',
    product: '',
    loading: false,
    searched: false,
    verdict: { hit: false, title: '', sub: '' },
    rows: [],
  },

  onLoad() {
    this.init();
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
  },

  retry() {
    this.setData({ loginError: '', loggedOut: false, ready: false });
    app.retryLogin().then(() => this.init()).catch(() => {
      this.setData({ loginError: app.globalData.loginError || '登录失败，请重试', loggedOut: !!app.globalData.loggedOut });
    });
  },

  onRateChange(e) {
    this.setData({ rateText: Number(e.detail.rate).toFixed(2) });
    if (this.data.searched) this.render();
  },

  onBuyerInput(e) {
    this.setData({ buyer: e.detail.value });
  },

  onProductInput(e) {
    this.setData({ product: e.detail.value });
  },

  async search() {
    const buyer = String(this.data.buyer).trim();
    const product = String(this.data.product).trim();
    if (!buyer) {
      wx.showToast({ title: '请先填写客户姓名', icon: 'none' });
      return;
    }
    this.setData({ loading: true, searched: true });
    const res = await db.findPurchases(buyer);
    this.setData({ loading: false });
    if (res.error) {
      this.rows = [];
      this.setData({
        rows: [],
        verdict: { hit: false, title: '查询失败', sub: describeDbError(res.error) },
      });
      return;
    }
    this.rows = res.data || [];
    this.render(buyer, product);
  },

  /* 商品展示名：名称 + 编码，商品被删了也能认出来 */
  nameOf(p) {
    if (!p) return '（商品已删除）';
    return [p.name, p.code].filter(Boolean).join(' ');
  },

  render(buyerArg, productArg) {
    const buyer = buyerArg === undefined ? String(this.data.buyer).trim() : buyerArg;
    const product = productArg === undefined ? String(this.data.product).trim() : productArg;
    const kw = product.toLowerCase();
    const rate = Number(app.globalData.rate) || 7.2;

    const sales = (this.rows || []).filter((m) => {
      if (!kw) return true;
      return this.nameOf(m.product).toLowerCase().indexOf(kw) >= 0;
    });

    /* 按订单聚合：同一单里同商品多笔合并，退货冲减 */
    const map = new Map();
    sales.forEach((m) => {
      const no = String(m.order_no == null ? '' : m.order_no);
      if (!no) return;
      let o = map.get(no);
      if (!o) {
        o = { no, at: m.created_at, ts: 0, qty: 0, amount: 0, names: new Map() };
        map.set(no, o);
      }
      const qty = Number(m.quantity) || 0;
      const price = Number(m.unit_price) || 0;
      const sign = m.move_type === 'out' ? 1 : -1;
      o.qty += qty * sign;
      o.amount += qty * price * sign;
      const name = this.nameOf(m.product);
      o.names.set(name, (o.names.get(name) || 0) + qty * sign);
      const t = new Date(m.created_at).getTime();
      if (Number.isFinite(t) && t > o.ts) { o.ts = t; o.at = m.created_at; }
    });

    const orders = Array.from(map.values())
      .filter((o) => o.qty > 0)
      .sort((a, b) => b.ts - a.ts);

    if (orders.length === 0) {
      this.setData({
        rows: [],
        verdict: {
          hit: false,
          title: '没有买过',
          sub: '客户「' + buyer + '」' + (product ? '购买「' + product + '」' : '') + '的记录：0 条',
        },
      });
      return;
    }

    const totalQty = orders.reduce((s, o) => s + o.qty, 0);
    const totalUsd = orders.reduce((s, o) => s + o.amount, 0);

    const rows = orders.map((o) => {
      const items = Array.from(o.names.entries())
        .filter((e) => e[1] > 0)
        .map((e) => e[0] + ' ×' + e[1])
        .join('、');
      return {
        no: o.no,
        timeText: fmtTime(o.at),
        itemsText: items,
        qty: o.qty,
        amountText: fmtUsd(o.amount),
      };
    });

    this.setData({
      rows,
      verdict: {
        hit: true,
        title: '买过',
        sub: '客户「' + buyer + '」' + (product ? '购买「' + product + '」' : '共购买') +
          '：' + orders.length + ' 单 · ' + totalQty + ' 件 · ' + fmtUsd(totalUsd) +
          '（≈ ' + fmtMoney(totalUsd * rate) + '），最近一次 ' + fmtTime(orders[0].at),
      },
    });
  },

  openOrder(e) {
    const no = e.currentTarget.dataset.no;
    if (!no) return;
    wx.navigateTo({ url: '/pages/order-detail/order-detail?no=' + encodeURIComponent(no) });
  },

  clear() {
    this.rows = [];
    this.setData({
      buyer: '',
      product: '',
      searched: false,
      rows: [],
      verdict: { hit: false, title: '', sub: '' },
    });
  },
});
