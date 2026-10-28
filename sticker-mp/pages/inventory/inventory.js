const app = getApp();
const db = require('../../utils/db');
const { toNum, fmtUsd, fmtTime, moneyOrDash, usdOrDash, CHANNEL_OPTIONS, SUPPLIER_PRESETS } = require('../../utils/format');
const { describeDbError } = require('../../utils/errors');
const { ALL_BRANDS, brandKeyOf, buildBrandStats } = require('../../utils/stats');

const LOW_STOCK_AT = 5;

function inventoryEmptyText(allCount, keyword, archivedView) {
  if (allCount === 0) return '还没有商品，先去「建档」录一个';
  if (archivedView) return keyword ? '归档商品里没有匹配的' : '还没有归档的商品';
  if (keyword) return '没有匹配的商品';
  return '该品牌下暂无商品';
}

Page({
  data: {
    ready: false,
    loginError: '',
    loggedOut: false,
    rateText: '7.20',
    loading: true,
    products: [],
    brands: [],
    brandKey: ALL_BRANDS,
    keyword: '',
    archivedView: false,
    archivedCount: 0,
    list: [],
    countText: '',
    orderNo: '',
    buyerName: '',
    activeOrder: null,
    orderStatusText: '',
    dialog: {
      show: false, title: '', note: '', fields: [], error: '', busy: false, submitText: '确定',
    },
    dialogMode: '',
    currentId: null,
    photoUrls: [],
  },

  onLoad() {
    this.init();
  },

  onShow() {
    if (!this.data.ready) return;
    this.syncOrderBar();
    this.loadInventory();
  },

  onPullDownRefresh() {
    this.loadInventory().then(() => wx.stopPullDownRefresh());
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
    this.syncOrderBar();
    await this.loadInventory();
  },

  retry() {
    this.setData({ loginError: '', loggedOut: false, ready: false });
    app.retryLogin().then(() => this.init()).catch(() => {
      this.setData({ loginError: app.globalData.loginError || '登录失败，请重试', loggedOut: !!app.globalData.loggedOut });
    });
  },

  onRateChange(e) {
    this.setData({ rateText: Number(e.detail.rate).toFixed(2) });
  },

  /* ---------- 出库会话 ---------- */

  syncOrderBar() {
    const active = app.getActiveOrder();
    let text;
    if (!active) {
      text = '未在出库中。填写订单 ID 后点「开始出库」，之后出库的商品都会记到这个订单号下；客户姓名选填。';
    } else {
      const who = active.buyerName ? '（客户 ' + active.buyerName + '）' : '';
      const progress = active.moves > 0
        ? ' · 已出库 ' + active.moves + ' 笔 / ' + active.qty + ' 件 / ' + fmtUsd(active.amount)
        : ' · 还没出库任何商品';
      text = '正在为订单 ' + active.no + who + ' 出库（' + fmtTime(active.startedAt) + ' 开始）' + progress;
    }
    this.setData({ activeOrder: active, orderStatusText: text });
  },

  onOrderInput(e) {
    this.setData({ orderNo: e.detail.value });
  },

  onBuyerInput(e) {
    this.setData({ buyerName: e.detail.value });
  },

  async startOrder() {
    const no = String(this.data.orderNo).trim();
    let buyerName = String(this.data.buyerName).trim();
    if (!no) {
      wx.showToast({ title: '请先填写订单 ID', icon: 'none' });
      return;
    }

    const active = app.getActiveOrder();
    if (active && active.no === no) {
      if ((active.buyerName || '') === buyerName) {
        wx.showToast({ title: '已经在为这个订单出库', icon: 'none' });
      } else {
        const prev = active.buyerName || '未填';
        active.buyerName = buyerName;
        app.setActiveOrder(active);
        this.syncOrderBar();
        wx.showToast({ title: '客户已从「' + prev + '」改为「' + (buyerName || '未填') + '」', icon: 'none' });
      }
      this.setData({ orderNo: '', buyerName: '' });
      return;
    }

    /* 先查云端：老订单带出已有出库进度，与新订单区分开 */
    wx.showLoading({ title: '查询订单中…', mask: true });
    const existing = await db.getOrderSummary(no);
    wx.hideLoading();
    let qty = 0, moves = 0, amount = 0;
    let summaryNote = '';
    if (existing && existing.moves > 0) {
      moves = existing.moves;
      qty = existing.qty;
      amount = existing.amount;
      // 客户姓名：用户没填就带出订单里已有的
      if (!buyerName && existing.buyer) buyerName = existing.buyer;
      summaryNote = '已有 ' + moves + ' 笔 / ' + qty + ' 件 / ' + fmtUsd(amount) + '，继续出库即可';
    }

    const prevNo = active ? active.no : '';
    app.setActiveOrder({
      no,
      buyerName,
      startedAt: new Date().toISOString(),
      qty: qty,
      moves: moves,
      amount: amount,
    });
    this.syncOrderBar();
    this.setData({ orderNo: '', buyerName: '' });
    const who = buyerName ? '（' + buyerName + '）' : '';
    if (summaryNote) {
      wx.showToast({ title: '订单 ' + no + who + summaryNote, icon: 'none', duration: 3000 });
    } else {
      wx.showToast({
        title: prevNo ? '已结束 ' + prevNo + '，新订单 ' + no + who + '开始出库' : '新订单，开始为 ' + no + who + '出库',
        icon: 'none',
      });
    }
  },

  endOrder() {
    const active = app.getActiveOrder();
    if (!active) return;
    app.setActiveOrder(null);
    this.syncOrderBar();
    const who = active.buyerName ? '（' + active.buyerName + '）' : '';
    const tail = active.moves > 0
      ? '：' + active.moves + ' 笔 / ' + active.qty + ' 件 / ' + fmtUsd(active.amount)
      : '（未出库任何商品）';
    wx.showToast({ title: '订单 ' + active.no + who + ' 出库结束' + tail, icon: 'none' });
  },

  /* ---------- 列表 ---------- */

  async loadInventory() {
    this.setData({ loading: true });
    try {
      const res = await db.listProducts();
      if (res.error) {
        this.setData({ loading: false, list: [], countText: describeDbError(res.error) });
        return;
      }
      const products = Array.isArray(res.data) ? res.data : [];
      /* 共享模式：把本人名下的老照片（users/ 私有目录）迁到 shared/，否则别人看不到图。
         没有待迁移项时直接返回，不影响首屏 */
      try { await db.migrateLegacyPhotos(products); } catch (e) { /* 迁移失败不阻塞列表 */ }
      let brandKey = this.data.brandKey;
      /* 品牌统计只看当前视图（在售 / 已归档）下的商品 */
      const brands = buildBrandStats(products.filter((p) => !!p.archived === this.data.archivedView));
      /* 选中的品牌若已不存在（商品被删除或改了品牌），自动回到「全部商品」 */
      if (brandKey !== ALL_BRANDS && !brands.some((s) => s.key === brandKey)) brandKey = ALL_BRANDS;

      this.setData({
        products,
        brands,
        brandKey,
        loading: false,
        archivedCount: products.filter((p) => !!p.archived).length,
      });
      this.render();

      /* 缩略图：批量换签名地址，失败就不显示图，不影响列表 */
      const paths = products.map((p) => p.image_path).filter(Boolean);
      if (paths.length) {
        const map = await db.signPhotoUrls(paths);
        this.photoMap = map;
        this.render();
      } else {
        this.photoMap = {};
      }
    } catch (err) {
      this.setData({ loading: false, list: [], countText: '加载失败，请重试' });
    }
  },

  render() {
    const { products, brandKey, keyword, archivedView } = this.data;
    const kw = String(keyword || '').trim().toLowerCase();
    const rows = products.filter((p) => {
      if (!!p.archived !== archivedView) return false;
      if (brandKey !== ALL_BRANDS && brandKeyOf(p) !== brandKey) return false;
      if (!kw) return true;
      return [p.name, p.code, p.brand]
        .some((v) => String(v == null ? '' : v).toLowerCase().indexOf(kw) >= 0);
    });

    const map = this.photoMap || {};
    const list = rows.map((p) => {
      const stock = Number(p.stock) || 0;
      let badgeText = '';
      let badgeCls = '';
      if (p.archived) { badgeText = '已归档'; badgeCls = 'badge-archived'; }
      else if (stock <= 0) { badgeText = '缺货'; badgeCls = 'badge-out'; }
      else if (stock <= LOW_STOCK_AT) { badgeText = '库存偏低'; badgeCls = 'badge-low'; }

      const detail = [
        p.brand ? '品牌 ' + p.brand : '',
        p.origin ? '产地 ' + p.origin : '',
        p.material ? '材质 ' + p.material : '',
        p.spec ? '规格 ' + p.spec : '',
        p.standard ? '执行标准 ' + p.standard : '',
      ].filter(Boolean).join(' · ') || '—';

      const source = [
        p.purchase_channel ? '渠道 ' + p.purchase_channel : '',
        p.supplier_name ? '进货商 ' + p.supplier_name : '',
      ].filter(Boolean).join(' · ') || '—';

      return {
        id: p.id,
        name: p.name,
        code: p.code || '',
        stock,
        badgeText,
        badgeCls,
        archived: !!p.archived,
        costText: moneyOrDash(p.cost_price),
        saleText: usdOrDash(p.sale_price),
        inText: p.last_in_at ? fmtTime(p.last_in_at) : '—',
        outText: p.last_out_at ? fmtTime(p.last_out_at) : '—',
        sourceText: source,
        detailText: detail,
        thumb: map[p.image_path] || '',
        canOut: stock > 0 && !p.archived,
        isUrgent: stock <= 0,
        photo: p.image_path || '',
      };
    });

    const total = products.length;
    const filtered = brandKey !== ALL_BRANDS || !!kw || archivedView;
    const archived = this.data.archivedCount;
    let countText = total === 0
      ? ''
      : (filtered ? '筛选出 ' + list.length + ' 款 / 共 ' + total + ' 款商品' : '共 ' + total + ' 款商品');
    if (!archivedView && archived > 0) countText += ' · 另有 ' + archived + ' 款已归档';

    this.setData({
      list,
      countText,
      emptyText: inventoryEmptyText(total, kw, archivedView),
      photoUrls: list.map((x) => x.thumb).filter(Boolean),
    });
  },

  /* 在售 / 已归档 视图切换 */
  toggleArchivedView(e) {
    const to = String(e.currentTarget.dataset.archived) === '1';
    if (to === this.data.archivedView) return;
    this.setData({ archivedView: to, brandKey: ALL_BRANDS });
    this.render();
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value });
    this.render();
  },

  selectBrand(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.brandKey) return;
    this.setData({ brandKey: key });
    this.render();
  },

  refresh() {
    this.loadInventory();
    wx.showToast({ title: '已刷新', icon: 'none' });
  },

  previewPhoto(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.previewImage({ current: url, urls: this.data.photoUrls });
  },

  /* ---------- 弹窗 ---------- */

  openDialog(cfg) {
    this.setData({
      dialogMode: cfg.mode,
      currentId: cfg.id,
      dialog: {
        show: true,
        title: cfg.title,
        note: cfg.note || '',
        fields: cfg.fields || [],
        error: '',
        busy: false,
        submitText: cfg.submitText || '确定',
        dangerText: cfg.dangerText || '',
      },
    });
  },

  closeDialog() {
    this.setData({ 'dialog.show': false });
  },

  setDialogError(msg) {
    this.setData({ 'dialog.error': msg, 'dialog.busy': false });
  },

  currentProduct() {
    return this.data.products.filter((p) => String(p.id) === String(this.data.currentId))[0] || null;
  },

  /* ---------- 删除商品（编辑弹窗左下角红色按钮） ---------- */

  onDialogDanger() {
    const p = this.currentProduct();
    if (!p) return;
    wx.showModal({
      title: '删除商品',
      content: '「' + (p.name || p.code) + '」及其全部出入库流水会一并删除，报表统计同步减少，删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#dc2626',
      success: (res) => { if (res.confirm) this.doDeleteProduct(p); },
    });
  },

  async doDeleteProduct(p) {
    this.setData({ 'dialog.busy': true });
    try {
      const del = await db.deleteProduct(p);
      if (del.error) { this.setDialogError('删除失败：' + describeDbError(del.error)); return; }
      this.closeDialog();
      wx.showToast({ title: '商品已删除', icon: 'success' });
      await this.loadInventory();
    } catch (err) {
      this.setDialogError((err && err.message) || '删除失败，请重试');
    }
  },

  /* ---------- 归档 / 恢复 ----------
     归档 = 停售不抹历史：从在售列表隐藏、不能出库补货，
     历史流水、订单与报表全部保留，可随时恢复 */
  archiveProduct(e) {
    const id = e.currentTarget.dataset.id;
    const p = this.data.products.filter((x) => String(x.id) === String(id))[0];
    if (!p) return;
    wx.showModal({
      title: '归档商品',
      content: '「' + (p.name || p.code) + '」会从库存列表隐藏，不能再出库 / 补货；历史流水、订单与报表全部保留，之后可在「已归档」里恢复上架。',
      confirmText: '归档',
      success: async (res) => {
        if (!res.confirm) return;
        const up = await db.updateProduct(p.id, { archived: true, updated_at: new Date().toISOString() });
        if (up.error) {
          wx.showToast({ title: describeDbError(up.error), icon: 'none' });
          return;
        }
        wx.showToast({ title: '已归档', icon: 'success' });
        await this.loadInventory();
      },
    });
  },

  restoreProduct(e) {
    const id = e.currentTarget.dataset.id;
    const p = this.data.products.filter((x) => String(x.id) === String(id))[0];
    if (!p) return;
    wx.showModal({
      title: '恢复上架',
      content: '「' + (p.name || p.code) + '」会重新出现在在售列表，可以正常出库 / 补货。当前库存 ' + (Number(p.stock) || 0) + ' 件。',
      confirmText: '恢复',
      success: async (res) => {
        if (!res.confirm) return;
        const up = await db.updateProduct(p.id, { archived: false, updated_at: new Date().toISOString() });
        if (up.error) {
          wx.showToast({ title: describeDbError(up.error), icon: 'none' });
          return;
        }
        wx.showToast({ title: '已恢复上架', icon: 'success' });
        await this.loadInventory();
      },
    });
  },

  openMoveOut(e) {    const id = e.currentTarget.dataset.id;
    const p = this.data.products.filter((x) => String(x.id) === String(id))[0];
    if (!p) return;
    const stock = Number(p.stock) || 0;
    if (p.archived) {
      wx.showToast({ title: '「' + p.name + '」已归档，先恢复上架再出库', icon: 'none' });
      return;
    }
    if (stock <= 0) {
      wx.showToast({ title: '「' + p.name + '」已缺货，请先补货', icon: 'none' });
      return;
    }
    const active = app.getActiveOrder();
    if (!active) {
      wx.showToast({ title: '出库必须关联订单号，请先「开始出库」', icon: 'none' });
      return;
    }

    this.openDialog({
      mode: 'out',
      id: p.id,
      title: '出库销售',
      submitText: '确认出库',
      note: '当前订单 ' + active.no + (active.buyerName ? '（客户 ' + active.buyerName + '）' : '') +
        ' · 本商品库存 ' + stock + ' 件',
      fields: [
        { key: 'qty', label: '数量', type: 'number', value: '1', placeholder: '1' },
        { key: 'price', label: '成交单价（美元 $）', type: 'digit', value: String(Number(p.sale_price) || 0) },
        { key: 'note', label: '备注', type: 'text', value: '', placeholder: '选填', tip: '本单的商品都会记到该订单名下；客户姓名可在订单页补填' },
      ],
    });
  },

  openMoveIn(e) {
    const id = e.currentTarget.dataset.id;
    const p = this.data.products.filter((x) => String(x.id) === String(id))[0];
    if (!p) return;
    if (p.archived) {
      wx.showToast({ title: '「' + p.name + '」已归档，先恢复上架再补货', icon: 'none' });
      return;
    }
    this.openDialog({
      mode: 'in',
      id: p.id,
      title: '补货入库',
      submitText: '确认入库',
      note: p.name + ' · 当前库存 ' + (Number(p.stock) || 0) + ' 件',
      fields: [
        { key: 'qty', label: '数量', type: 'number', value: '1', placeholder: '1' },
        { key: 'price', label: '进货单价（人民币 ¥）', type: 'digit', value: String(Number(p.cost_price) || 0) },
      ],
    });
  },

  openEdit(e) {
    const id = e.currentTarget.dataset.id;
    const p = this.data.products.filter((x) => String(x.id) === String(id))[0];
    if (!p) return;

    /* 历史值并入选项（预置在前），旧渠道/旧进货商仍能选中 */
    const hist = (field) => Array.from(new Set(
      this.data.products.map((x) => String((x && x[field]) || '').trim()).filter(Boolean)
    ));
    const channelRange = CHANNEL_OPTIONS.concat(
      hist('purchase_channel').filter((v) => !CHANNEL_OPTIONS.includes(v))
    );
    const supplierRange = SUPPLIER_PRESETS.concat(
      hist('supplier_name').filter((v) => !SUPPLIER_PRESETS.includes(v))
    );

    this.openDialog({
      mode: 'edit',
      id: p.id,
      title: '编辑商品',
      submitText: '保存',
      dangerText: '删除商品',
      note: '库存不在这里直接改，请用「补货 / 出库销售」以保证流水完整。',
      fields: [
        { key: 'code', label: '产品编码', type: 'text', value: p.code || '' },
        { key: 'name', label: '产品名称', type: 'text', value: p.name || '' },
        { key: 'brand', label: '品牌', type: 'text', value: p.brand || '', placeholder: '选填' },
        { key: 'origin', label: '产地', type: 'text', value: p.origin || '', placeholder: '选填' },
        { key: 'material', label: '材质', type: 'text', value: p.material || '', placeholder: '选填' },
        { key: 'spec', label: '规格', type: 'text', value: p.spec || '', placeholder: '选填' },
        { key: 'standard', label: '执行标准', type: 'text', value: p.standard || '', placeholder: '选填' },
        {
          key: 'channel', label: '进货渠道', type: 'select',
          value: p.purchase_channel || '',
          options: [''].concat(channelRange),
          optionLabels: ['不填'].concat(channelRange),
          placeholder: '不填',
        },
        {
          key: 'supplier', label: '进货商名称', type: 'combo',
          value: p.supplier_name || '', placeholder: '选填，可输入或点「选择」',
          options: supplierRange,
        },
        { key: 'cost', label: '进价（人民币 ¥）', type: 'digit', value: p.cost_price == null ? '' : String(p.cost_price), placeholder: '选填' },
        { key: 'sale', label: '售价（美元 $）', type: 'digit', value: p.sale_price == null ? '' : String(p.sale_price), placeholder: '选填' },
        { key: 'note', label: '备注', type: 'text', value: p.note || '', placeholder: '选填' },
      ],
    });
  },

  async onDialogSubmit(e) {
    const mode = this.data.dialogMode;
    const values = e.detail.values || {};
    this.setData({ 'dialog.busy': true, 'dialog.error': '' });

    if (mode === 'edit') { await this.submitEdit(values); return; }
    await this.submitMove(values, mode);
  },

  async submitMove(values, mode) {
    const isOut = mode === 'out';
    const p = this.currentProduct();
    if (!p) { this.setDialogError('商品不存在，请刷新后重试'); return; }

    const qty = Math.round(toNum(values.qty));
    const price = toNum(values.price);
    if (qty <= 0) { this.setDialogError('数量必须大于 0'); return; }

    const current = Number(p.stock) || 0;
    if (isOut && qty > current) { this.setDialogError('库存不足，当前只有 ' + current); return; }

    const active = app.getActiveOrder();
    if (isOut && !active) {
      this.setDialogError('出库必须关联订单号：请先填写订单 ID 并点「开始出库」');
      return;
    }

    const move = {
      product_id: p.id,
      move_type: isOut ? 'out' : 'in',
      quantity: qty,
      unit_price: price,
    };
    if (isOut) {
      move.order_no = active.no;
      if (active.buyerName) move.buyer_name = active.buyerName;
      const note = String(values.note || '').trim();
      if (note) move.buyer_note = note;
    }

    try {
      const ins = await db.insertMove(move);
      if (ins.error) { this.setDialogError(describeDbError(ins.error)); return; }

      const nowIso = new Date().toISOString();
      const patch = {
        stock: isOut ? current - qty : current + qty,
        updated_at: nowIso,
      };
      if (isOut) patch.last_out_at = nowIso;
      else patch.last_in_at = nowIso;

      const upd = await db.updateProduct(p.id, patch);
      if (upd.error) {
        this.setDialogError('流水已记录，但库存更新失败：' + describeDbError(upd.error));
        return;
      }
      if (!Array.isArray(upd.data) || upd.data.length === 0) {
        this.setDialogError('库存更新未生效，请刷新后重试');
        return;
      }

      if (isOut) {
        const latest = app.getActiveOrder();
        if (latest && latest.no === move.order_no) {
          latest.qty += qty;
          latest.moves += 1;
          latest.amount += qty * price;
          app.setActiveOrder(latest);
          this.syncOrderBar();
        }
      }

      this.closeDialog();
      wx.showToast({ title: isOut ? '出库成功' : '补货成功', icon: 'success' });
      await this.loadInventory();
    } catch (err) {
      this.setDialogError((err && err.message) || '操作失败，请重试');
    }
  },

  async submitEdit(values) {
    const p = this.currentProduct();
    if (!p) { this.setDialogError('商品不存在，请刷新后重试'); return; }

    const name = String(values.name || '').trim();
    if (!name) { this.setDialogError('产品名称不能为空'); return; }

    const trimOrNull = (v) => {
      const s = String(v == null ? '' : v).trim();
      return s === '' ? null : s;
    };

    try {
      const upd = await db.updateProduct(p.id, {
        code: String(values.code || '').trim(),
        name,
        brand: trimOrNull(values.brand),
        origin: trimOrNull(values.origin),
        material: trimOrNull(values.material),
        spec: trimOrNull(values.spec),
        standard: trimOrNull(values.standard),
        purchase_channel: trimOrNull(values.channel),
        supplier_name: trimOrNull(values.supplier),
        cost_price: String(values.cost || '').trim() === '' ? null : toNum(values.cost),
        sale_price: String(values.sale || '').trim() === '' ? null : toNum(values.sale),
        note: trimOrNull(values.note),
        updated_at: new Date().toISOString(),
      });
      if (upd.error) { this.setDialogError(describeDbError(upd.error)); return; }
      if (!Array.isArray(upd.data) || upd.data.length === 0) {
        this.setDialogError('未修改任何数据，请刷新后重试');
        return;
      }
      this.closeDialog();
      wx.showToast({ title: '已保存', icon: 'success' });
      await this.loadInventory();
    } catch (err) {
      this.setDialogError((err && err.message) || '保存失败，请重试');
    }
  },
});
