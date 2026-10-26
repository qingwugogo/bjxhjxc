const app = getApp();
const db = require('../../utils/db');
const { cloud } = require('../../utils/cloud');
const { fmtUsd, fmtMoney, fmtRange, fmtDate, toNum } = require('../../utils/format');
const { describeDbError } = require('../../utils/errors');
const { buildOrderStats, orderCardView, orderProductLines } = require('../../utils/stats');

const MOVE_COLS = '*, product:products(id, name, code, cost_price)';

Page({
  data: {
    ready: false,
    loginError: '',
    loggedOut: false,
    rateText: '7.20',
    loading: true,
    no: '',
    missing: false,
    detail: null,
    dialog: { show: false, title: '', note: '', fields: [], error: '', busy: false, submitText: '确定' },
    dialogMode: '',
  },

  onLoad(query) {
    const no = decodeURIComponent((query && query.no) || '');
    this.setData({ no });
    if (no) wx.setNavigationBarTitle({ title: '订单 ' + no });
    this.init();
  },

  onPullDownRefresh() {
    this.loadDetail().then(() => wx.stopPullDownRefresh());
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
    await this.loadDetail();
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

  async loadDetail() {
    if (!this.data.no) return;
    this.setData({ loading: true });
    try {
      const [movesRes, costs, ships] = await Promise.all([
        cloud.database.from('stock_moves').select(MOVE_COLS)
          .eq('order_no', this.data.no).order('created_at', { ascending: true }).limit(1000),
        db.listOrderCosts(),
        db.listShipments(),
      ]);
      if (movesRes.error) {
        this.setData({ loading: false, missing: true });
        wx.showToast({ title: describeDbError(movesRes.error), icon: 'none' });
        return;
      }
      this.rows = Array.isArray(movesRes.data) ? movesRes.data : [];
      this.costs = costs;
      this.ships = ships;
      this.setData({ loading: false });
      this.render();
    } catch (err) {
      this.setData({ loading: false, missing: true });
    }
  },

  render() {
    const rows = this.rows || [];
    const { list } = buildOrderStats(rows, this.data.no, {
      rate: app.globalData.rate,
      costs: this.costs || new Map(),
    });
    const r = list[0];
    if (!r) {
      this.setData({ detail: null, missing: true });
      return;
    }

    const lines = orderProductLines(rows, this.data.no);
    const outs = rows.filter((m) => m.move_type === 'out');
    const returns = rows.filter((m) => m.move_type !== 'out' && m.is_return);
    const otherIns = rows.filter((m) => m.move_type !== 'out' && !m.is_return);

    const cell = (m, sign) => {
      const p = m.product || {};
      const qty = Number(m.quantity) || 0;
      const price = Number(m.unit_price) || 0;
      const unitCost = p ? (Number(p.cost_price) || 0) : 0;
      const prefix = sign < 0 ? '-' : '';
      return {
        key: m.id,
        name: p.name || '（商品已删除）',
        code: p.code || '',
        isReturn: sign < 0,
        qtyText: prefix + qty,
        priceText: fmtUsd(price),
        totalText: prefix + fmtUsd(qty * price),
        costText: prefix + fmtMoney(qty * unitCost),
      };
    };

    const detailLines = outs.map((m) => cell(m, 1)).concat(returns.map((m) => cell(m, -1)));

    const s = (this.ships || new Map()).get(String(this.data.no));
    const hasShip = !!(s && (s.carrier || s.shipped_at || s.arrived_at || s.signed_at || s.tracking_no));
    const shipment = {
      has: hasShip,
      carrier: (s && s.carrier) || '—',
      shippedText: s ? fmtDate(s.shipped_at) : '—',
      arrivedText: s ? fmtDate(s.arrived_at) : '—',
      signedText: s ? fmtDate(s.signed_at) : '—',
      trackingNo: (s && s.tracking_no) || '—',
    };

    const returnLines = lines.filter((l) => l.outQty > 0).map((l) => ({
      productId: l.product_id,
      name: l.name,
      outQty: l.outQty,
      returnQty: l.returnQty,
      netQty: l.netQty,
      canReturn: l.netQty > 0,
    }));

    this.setData({
      missing: false,
      detail: {
        orderNo: r.order_no,
        buyerText: r.buyer || '—',
        moves: r.moves,
        qty: r.qty,
        returnQty: r.returnQty,
        range: fmtRange(r.firstAt, r.lastAt),
        card: orderCardView(r),
        shipment,
        lines: detailLines,
        returnLines,
        hasReturns: returns.length > 0,
        otherIns: otherIns.length,
        lastPriceOf: {},
      },
    });
  },

  /* ---------- 弹窗 ---------- */

  openDialog(cfg) {
    this.setData({
      dialogMode: cfg.mode,
      dialog: {
        show: true,
        title: cfg.title,
        note: cfg.note || '',
        fields: cfg.fields || [],
        error: '',
        busy: false,
        submitText: cfg.submitText || '保存',
      },
    });
    this._dialogMeta = cfg.meta || {};
  },

  closeDialog() {
    this.setData({ 'dialog.show': false });
  },

  /* ---------- 其他成本 ---------- */

  openCost() {
    const extra = (this.costs && this.costs.get(String(this.data.no))) || { other_cost: 0, cost_note: '' };
    this.openDialog({
      mode: 'cost',
      title: '订单其他成本',
      note: '这里填除商品进价之外的整单费用，比如运费、平台佣金、包装费。保存后自动从利润里扣掉。',
      fields: [
        { key: 'other_cost', label: '其他成本（元）', type: 'digit', value: String(extra.other_cost || 0) },
        { key: 'cost_note', label: '费用说明（选填）', type: 'text', value: extra.cost_note || '', placeholder: '例如：运费 5 + 平台佣金 2' },
      ],
    });
  },

  /* ---------- 客户姓名 ---------- */

  openBuyer() {
    const d = this.data.detail;
    this.openDialog({
      mode: 'buyer',
      title: '修改客户姓名',
      note: '修改后，该订单下所有出库流水的客户姓名会一起更新。',
      fields: [
        { key: 'buyer', label: '客户姓名', type: 'text', value: d.buyerText === '—' ? '' : d.buyerText, placeholder: '选填', maxlength: 24 },
      ],
    });
  },

  /* ---------- 发货信息 ---------- */

  openShipment() {
    const s = (this.ships && this.ships.get(String(this.data.no))) || {};
    const day = (v) => (v ? String(v).slice(0, 10) : '');
    this.openDialog({
      mode: 'shipment',
      title: '发货信息',
      note: '一个订单一条发货记录；五项全部留空保存 = 清除这条记录。',
      fields: [
        { key: 'carrier', label: '物流商', type: 'text', value: s.carrier || '', placeholder: '例如：燕文 / 云途 / 4PX' },
        { key: 'shipped_at', label: '发货日期', type: 'date', value: day(s.shipped_at) },
        { key: 'arrived_at', label: '到仓时间', type: 'date', value: day(s.arrived_at) },
        { key: 'signed_at', label: '签收时间', type: 'date', value: day(s.signed_at) },
        { key: 'tracking_no', label: '国际单号', type: 'text', value: s.tracking_no || '', placeholder: '选填' },
      ],
    });
  },

  /* ---------- 退回库存 ---------- */

  openReturn(e) {
    const productId = e.currentTarget.dataset.id;
    const line = (this.data.detail.returnLines || [])
      .filter((l) => String(l.productId) === String(productId))[0];
    if (!line || line.netQty <= 0) {
      wx.showToast({ title: '该商品在本单没有可退回的数量', icon: 'none' });
      return;
    }
    const rows = this.rows || [];
    const prices = rows.filter((m) => String(m.product_id) === String(productId) && m.move_type === 'out');
    const lastPrice = prices.length ? Number(prices[prices.length - 1].unit_price) || 0 : 0;

    this.openDialog({
      mode: 'return',
      title: '退回库存',
      note: line.name + '：本单出库 ' + line.outQty + ' 件' +
        (line.returnQty > 0 ? '，已退回 ' + line.returnQty + ' 件' : '') +
        '，可退回 ' + line.netQty + ' 件。退回后库存立即加回，本单金额、成本与利润按退回数量冲减（按最后一笔出库单价 ' +
        fmtUsd(lastPrice) + ' 计）。',
      fields: [
        { key: 'qty', label: '退回数量', type: 'number', value: String(line.netQty) },
      ],
      meta: { productId, netQty: line.netQty, lastPrice },
    });
  },

  async onSubmit(e) {
    const values = e.detail.values || {};
    const mode = this.data.dialogMode;
    this.setData({ 'dialog.busy': true, 'dialog.error': '' });
    try {
      if (mode === 'cost') await this.submitCost(values);
      else if (mode === 'buyer') await this.submitBuyer(values);
      else if (mode === 'shipment') await this.submitShipment(values);
      else if (mode === 'return') await this.submitReturn(values);
    } catch (err) {
      this.setData({ 'dialog.error': (err && err.message) || '操作失败，请重试', 'dialog.busy': false });
    }
  },

  async submitCost(values) {
    const raw = String(values.other_cost == null ? '' : values.other_cost).trim();
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || value < 0) {
      this.setData({ 'dialog.error': '请填写不小于 0 的金额', 'dialog.busy': false });
      return;
    }
    const note = String(values.cost_note || '').trim();
    const res = await db.saveOrderCost(this.data.no, value, note);
    if (res.error) {
      this.setData({ 'dialog.error': describeDbError(res.error), 'dialog.busy': false });
      return;
    }
    this.costs.set(String(this.data.no), { other_cost: value, cost_note: note });
    this.setData({ 'dialog.show': false, 'dialog.busy': false });
    wx.showToast({ title: '已保存其他成本', icon: 'success' });
    this.render();
  },

  async submitBuyer(values) {
    const name = String(values.buyer || '').trim();
    const upd = await cloud.database.from('stock_moves')
      .update({ buyer_name: name || null })
      .eq('order_no', this.data.no)
      .eq('move_type', 'out')
      .select();
    if (upd.error) {
      this.setData({ 'dialog.error': describeDbError(upd.error), 'dialog.busy': false });
      return;
    }
    if (!Array.isArray(upd.data) || upd.data.length === 0) {
      this.setData({ 'dialog.error': '没有找到该订单的出库流水，请刷新后重试', 'dialog.busy': false });
      return;
    }
    this.setData({ 'dialog.show': false, 'dialog.busy': false });
    wx.showToast({ title: name ? '客户已改为「' + name + '」' : '已清空客户姓名', icon: 'none' });
    await this.loadDetail();
  },

  async submitShipment(values) {
    const payload = {
      carrier: String(values.carrier || '').trim() || null,
      shipped_at: values.shipped_at || null,
      arrived_at: values.arrived_at || null,
      signed_at: values.signed_at || null,
      tracking_no: String(values.tracking_no || '').trim() || null,
    };
    const cleared = !payload.carrier && !payload.shipped_at && !payload.arrived_at &&
      !payload.signed_at && !payload.tracking_no;
    const res = await db.saveShipment(this.data.no, payload);
    if (res.error) {
      this.setData({ 'dialog.error': describeDbError(res.error), 'dialog.busy': false });
      return;
    }
    if (this.ships && res.data) this.ships.set(String(this.data.no), res.data);
    this.setData({ 'dialog.show': false, 'dialog.busy': false });
    wx.showToast({ title: cleared ? '已清除发货记录' : '发货信息已保存', icon: 'none' });
    this.render();
  },

  async submitReturn(values) {
    const meta = this._dialogMeta || {};
    const qty = Math.round(toNum(values.qty));
    if (qty <= 0) {
      this.setData({ 'dialog.error': '退回数量必须大于 0', 'dialog.busy': false });
      return;
    }
    if (qty > meta.netQty) {
      this.setData({ 'dialog.error': '最多只能退回 ' + meta.netQty + ' 件', 'dialog.busy': false });
      return;
    }

    const pr = await db.getProductStock(meta.productId);
    if (pr.error || !pr.data) {
      this.setData({ 'dialog.error': '读取商品库存失败，请重试', 'dialog.busy': false });
      return;
    }
    const cur = Number(pr.data.stock) || 0;

    const ins = await db.insertMove({
      product_id: meta.productId,
      move_type: 'in',
      quantity: qty,
      unit_price: meta.lastPrice,
      order_no: this.data.no,
      is_return: true,
      buyer_note: '订单退回库存',
    });
    if (ins.error) {
      this.setData({ 'dialog.error': describeDbError(ins.error), 'dialog.busy': false });
      return;
    }

    const nowIso = new Date().toISOString();
    const upd = await db.updateProduct(meta.productId, {
      stock: cur + qty, last_in_at: nowIso, updated_at: nowIso,
    });
    if (upd.error) {
      this.setData({ 'dialog.error': '退货流水已记录，但库存更新失败：' + describeDbError(upd.error), 'dialog.busy': false });
      return;
    }
    if (!Array.isArray(upd.data) || upd.data.length === 0) {
      this.setData({ 'dialog.error': '库存更新未生效，请刷新后重试', 'dialog.busy': false });
      return;
    }

    this.setData({ 'dialog.show': false, 'dialog.busy': false });
    wx.showToast({ title: '已退回 ' + qty + ' 件，金额已冲减', icon: 'success' });
    await this.loadDetail();
  },

  /* ---------- 其它操作 ---------- */

  gotoMoves() {
    app.globalData.pendingMoveFilter = this.data.no;
    wx.switchTab({ url: '/pages/moves/moves' });
  },

  copyOrderNo() {
    wx.setClipboardData({
      data: this.data.no,
      success: () => wx.showToast({ title: '已复制订单 ID', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请手动选中', icon: 'none' }),
    });
  },

  /* ---------- 删除订单 ---------- */

  onDeleteOrder() {
    const no = this.data.no;
    const rows = this.rows || [];
    const moveCount = rows.length;
    if (moveCount === 0) {
      wx.showToast({ title: '该订单没有流水，无需删除', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '删除订单',
      content: '订单 ' + no + ' 的 ' + moveCount + ' 笔流水会全部删除，'
        + '相关商品库存自动回补，其他成本与发货记录一并清除。删除后无法恢复，确定删除？',
      confirmText: '删除',
      confirmColor: '#dc2626',
      success: (res) => { if (res.confirm) this.doDeleteOrder(); },
    });
  },

  async doDeleteOrder() {
    if (this._deleting) return;
    this._deleting = true;
    wx.showLoading({ title: '正在删除…', mask: true });
    try {
      const res = await db.deleteOrder(this.data.no);
      wx.hideLoading();
      if (res.error) {
        wx.showToast({ title: '删除失败：' + describeDbError(res.error), icon: 'none' });
        return;
      }
      const d = res.data || {};
      let msg = '订单已删除';
      if (d.stockFailed > 0) msg += '，' + d.stockFailed + ' 个商品库存回补失败';
      wx.showToast({ title: msg, icon: d.stockFailed > 0 ? 'none' : 'success', duration: 2200 });
      setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/orders/orders' }) }), 900);
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '删除失败，请重试', icon: 'none' });
    } finally {
      this._deleting = false;
    }
  },
});
