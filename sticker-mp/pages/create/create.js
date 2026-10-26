const app = getApp();
const db = require('../../utils/db');
const { cloud } = require('../../utils/cloud');
const { toNum, CHANNEL_OPTIONS, SUPPLIER_PRESETS } = require('../../utils/format');
const { describeDbError, describeStorageError, describeLlmError } = require('../../utils/errors');

const RECOGNIZE_SYSTEM = [
  '你是一个商品标签识别助手，专门从商品照片中提取结构化信息。',
  '只输出一个 JSON 对象，不要输出任何解释文字、前后缀或 Markdown 代码块。',
  'JSON 必须包含且仅包含这些字段：name, brand, origin, material, spec, standard。',
  '每个字段的值都是字符串；照片中无法确认的项，值用空字符串。',
  '绝对不要编造照片中不存在的信息。',
].join('');

const RECOGNIZE_USER = [
  '请识别这张商品照片，提取以下字段：',
  '- name：产品名称',
  '- brand：品牌',
  '- origin：产地',
  '- material：材质',
  '- spec：规格',
  '- standard：执行标准',
  '仅返回 JSON。',
].join('\n');

/* 建档时的初始库存默认值：新到货多为单件样品，手动建档与识别建档统一按 1 件起 */
const DEFAULT_INITIAL_STOCK = 1;

/* 售价默认值 = 进价 × 0.66（进价人民币、售价美元；用户手动改过售价就不再自动覆盖） */
const SALE_DEFAULT_RATIO = 0.66;

function trimOrNull(v) {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? null : s;
}

Page({
  data: {
    ready: false,
    loginError: '',
    loggedOut: false,
    rateText: '7.20',
    photoPath: '',
    photoType: 'image/jpeg',
    hasPhoto: false,
    recognizing: false,
    recognizeStatus: '',
    recognizeStatusType: '',
    showReview: false,
    saving: false,
    saveStatus: '',
    saveStatusType: '',
    stockDefault: DEFAULT_INITIAL_STOCK,
    form: {
      code: '', name: '', brand: '', origin: '', material: '', spec: '', standard: '',
      channel: '', supplier: '', cost: '', sale: '', stock: String(DEFAULT_INITIAL_STOCK), note: '',
    },
    suggestions: { brand: [], channel: [], supplier: [] },
    /* 渠道下拉：值数组 + 显示数组（首项「不填」对应空值）；历史渠道会并入 */
    channelRange: CHANNEL_OPTIONS.slice(),
    channelLabels: ['不填'].concat(CHANNEL_OPTIONS),
    /* 进货商「选择」列表：预置项（悠米 / 小时光）+ 历史 */
    supplierRange: SUPPLIER_PRESETS.slice(),
  },

  onLoad() {
    this.init();
  },

  onShow() {
    if (this.data.ready) this.refreshSuggestions();
  },

  onPullDownRefresh() {
    this.init().then(() => wx.stopPullDownRefresh());
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
    this.refreshSuggestions();
    if (!this.data.form.code) {
      const code = await db.generateCode();
      this.setData({ 'form.code': code });
    }
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

  /* ---------- 照片 ---------- */

  choosePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = (res.tempFiles || [])[0];
        if (!file) return;
        if (file.size > 12 * 1024 * 1024) {
          wx.showToast({ title: '图片过大，请选 12MB 以内', icon: 'none' });
          return;
        }
        this.shrinkPhoto(file.tempFilePath);
      },
      fail: () => { /* 用户取消选择，不用提示 */ },
    });
  },

  /* 手机上原图动辄几 MB，识别和上传都慢，先压到 1024 长边量级 */
  shrinkPhoto(src) {
    wx.compressImage({
      src,
      quality: 80,
      success: (res) => this.applyPhoto(res.tempFilePath, 'image/jpeg'),
      fail: () => {
        const isPng = /\.png$/i.test(src);
        this.applyPhoto(src, isPng ? 'image/png' : 'image/jpeg');
      },
    });
  },

  applyPhoto(path, contentType) {
    this.setData({
      photoPath: path,
      photoType: contentType,
      hasPhoto: true,
      showReview: false,
      recognizeStatus: '',
      recognizeStatusType: '',
      saveStatus: '',
      saveStatusType: '',
    });
  },

  clearPhoto() {
    this.resetAll();
  },

  previewPhoto() {
    if (!this.data.photoPath) return;
    wx.previewImage({ urls: [this.data.photoPath] });
  },

  /* ---------- AI 识别 ---------- */

  isVisionModel(m) {
    if (!m) return false;
    if (m.supportsImages === true) return true;
    if (m.capabilities && m.capabilities.vision === true) return true;
    if (m.modalities && Array.isArray(m.modalities.input)) {
      return m.modalities.input.indexOf('image') >= 0;
    }
    return false;
  },

  async pickVisionModel() {
    if (this.activeModel) return this.activeModel;
    const models = await cloud.llm.models.list();
    if (!models || models.length === 0) return null;
    const usable = models.filter((m) => m.disabled !== true && m.enabled !== false);
    const vision = usable.filter((m) => this.isVisionModel(m));
    if (vision.length === 0) return null;
    const picked = vision.find((m) => m.isDefault === true)
      || vision.find((m) => m.capabilities && m.capabilities.jsonMode === true)
      || vision[0];
    this.activeModel = picked;
    return picked;
  },

  parseModelJson(text) {
    let raw = String(text || '').trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    let obj = {};
    try { obj = JSON.parse(raw); } catch (e) { obj = {}; }
    const pick = (k) => (typeof obj[k] === 'string' ? obj[k].trim() : '');
    return {
      name: pick('name'),
      brand: pick('brand'),
      origin: pick('origin'),
      material: pick('material'),
      spec: pick('spec'),
      standard: pick('standard'),
    };
  },

  toDataUrl(path) {
    const base64 = wx.getFileSystemManager().readFileSync(path, 'base64');
    return 'data:image/jpeg;base64,' + base64;
  },

  async recognize() {
    if (!this.data.photoPath || this.data.recognizing) return;
    this.setData({
      recognizing: true,
      recognizeStatus: '正在调用大模型识别，请稍候…',
      recognizeStatusType: '',
    });
    try {
      const model = await this.pickVisionModel();
      if (!model) {
        this.setData({ recognizeStatus: '当前没有可用的识别模型，请稍后重试', recognizeStatusType: 'is-error' });
        return;
      }

      const params = {
        model: model.id,
        messages: [
          { role: 'system', content: RECOGNIZE_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: RECOGNIZE_USER },
              { type: 'image_url', image_url: { url: this.toDataUrl(this.data.photoPath) } },
            ],
          },
        ],
        stream: true,
      };
      /* 仅在模型声明支持 JSON 模式时才下发，避免不支持该参数的模型直接报错 */
      if (model.capabilities && model.capabilities.jsonMode === true) {
        params.response_format = { type: 'json_object' };
      }

      let buffer = '';
      const stream = await cloud.llm.chat.completions.create(params);
      for await (const chunk of stream) {
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (delta && delta.content) buffer += delta.content;
      }

      const data = this.parseModelJson(buffer);
      const code = this.data.form.code || await db.generateCode();
      this.setData({
        showReview: true,
        recognizeStatus: '识别完成，请核对下方信息',
        recognizeStatusType: 'is-ok',
        saveStatus: '',
        saveStatusType: '',
        'form.code': code,
        'form.name': data.name,
        'form.brand': data.brand,
        'form.origin': data.origin,
        'form.material': data.material,
        'form.spec': data.spec,
        'form.standard': data.standard,
      });
      wx.pageScrollTo({ selector: '#review', duration: 300, offsetTop: -20 });
    } catch (err) {
      this.setData({ recognizeStatus: describeLlmError(err), recognizeStatusType: 'is-error' });
    } finally {
      this.setData({ recognizing: false });
    }
  },

  /* ---------- 表单 ---------- */

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    const patch = { ['form.' + field]: value };
    if (field === 'cost') {
      /* 填进价时自动带出默认售价（用户手动改过售价则不覆盖） */
      const cost = Number(value);
      if (!this.saleTouched && String(value).trim() !== '' && isFinite(cost) && cost >= 0) {
        patch['form.sale'] = String(Math.round(cost * SALE_DEFAULT_RATIO * 100) / 100);
      }
    } else if (field === 'sale') {
      this.saleTouched = String(value).trim() !== '';
    }
    this.setData(patch);
  },

  pickSuggestion(e) {
    const field = e.currentTarget.dataset.field;
    const idx = Number(e.detail.value) || 0;
    const list = this.data.suggestions[field] || [];
    const value = list[idx];
    if (value == null) return;
    this.setData({ ['form.' + field]: value });
  },

  /* 渠道下拉：第 0 项「不填」清空，其余按 channelRange 取值 */
  onChannelPick(e) {
    const idx = Number(e.detail.value) || 0;
    const value = idx === 0 ? '' : this.data.channelRange[idx - 1];
    if (value == null) return;
    this.setData({ 'form.channel': value });
  },

  async refreshSuggestions() {
    try {
      const res = await cloud.database.from('products').select('brand, purchase_channel, supplier_name');
      if (res.error || !Array.isArray(res.data)) return;
      const uniq = (field) => Array.from(new Set(
        res.data.map((r) => String((r && r[field]) || '').trim()).filter(Boolean)
      )).sort((a, b) => a.localeCompare(b, 'zh-CN'));

      /* 渠道：固定四项在前，历史渠道去重追加 */
      const channelRange = CHANNEL_OPTIONS.concat(
        uniq('purchase_channel').filter((v) => !CHANNEL_OPTIONS.includes(v))
      );
      /* 进货商：预置项在前，历史去重追加（仍可手动输入） */
      const supplierRange = SUPPLIER_PRESETS.concat(
        uniq('supplier_name').filter((v) => !SUPPLIER_PRESETS.includes(v))
      );

      this.setData({
        suggestions: {
          brand: uniq('brand'),
          supplier: supplierRange,
        },
        channelRange,
        /* 显示数组首项必须是「不填」，与 onChannelPick 的 idx0=清空 映射一致，
           否则会差一位：点「拼多多」被清空、点「小红书」选中「拼多多」 */
        channelLabels: ['不填'].concat(channelRange),
        supplierRange,
      });
    } catch (e) { /* 候选失败不影响建档 */ }
  },

  /* ---------- 保存 ---------- */

  async save() {
    const f = this.data.form;
    if (!this.data.photoPath) {
      wx.showToast({ title: '请先选择商品照片', icon: 'none' });
      return;
    }
    if (!String(f.name).trim()) {
      this.setData({ saveStatus: '请填写产品名称', saveStatusType: 'is-error' });
      return;
    }
    /* 进价 / 售价必填：非空且为非负数字 */
    const rawCost = String(f.cost).trim();
    const rawSale = String(f.sale).trim();
    if (rawCost === '' || !isFinite(Number(rawCost)) || Number(rawCost) < 0) {
      this.setData({ saveStatus: '请填写有效的进价（人民币 ¥）', saveStatusType: 'is-error' });
      return;
    }
    if (rawSale === '' || !isFinite(Number(rawSale)) || Number(rawSale) < 0) {
      this.setData({ saveStatus: '请填写有效的售价（美元 $）', saveStatusType: 'is-error' });
      return;
    }

    this.setData({ saving: true, saveStatus: '正在保存…', saveStatusType: '' });
    try {
      const up = await db.uploadPhoto(this.data.photoPath, this.data.photoType);
      if (up.error) {
        /* 控制台留原始错误（code / status），页面上只给人话，便于远程排查 */
        console.error('[create] uploadPhoto failed', up.error);
        throw new Error('照片上传失败：' + describeStorageError(up.error));
      }

      const stock = Math.max(0, Math.round(toNum(f.stock)));
      const payload = {
        code: String(f.code).trim() || await db.generateCode(),
        name: String(f.name).trim(),
        brand: trimOrNull(f.brand),
        origin: trimOrNull(f.origin),
        material: trimOrNull(f.material),
        spec: trimOrNull(f.spec),
        standard: trimOrNull(f.standard),
        purchase_channel: trimOrNull(f.channel),
        supplier_name: trimOrNull(f.supplier),
        image_path: up.data.path,
        cost_price: toNum(rawCost),
        sale_price: toNum(rawSale),
        stock,
        note: trimOrNull(f.note),
        /* 建档即为首次入库，初始库存为 0 时不算入库 */
        last_in_at: stock > 0 ? new Date().toISOString() : null,
      };

      const created = await db.createProduct(payload);
      if (created.error) throw new Error(describeDbError(created.error));
      if (!created.data) throw new Error('保存失败，请重试');

      if (stock > 0) {
        const mv = await db.insertMove({
          product_id: created.data.id,
          move_type: 'in',
          quantity: stock,
          unit_price: toNum(payload.cost_price),
        });
        if (mv.error) {
          this.setData({
            saveStatus: '商品已保存，但入库流水写入失败：' + describeDbError(mv.error),
            saveStatusType: 'is-error',
          });
          return;
        }
      }

      const msg = '已入库：' + created.data.name + '（' + created.data.code + '）' +
        (created.codeChanged ? ' · 原编码已被占用，已自动分配新编码' : '');
      await this.resetAll();
      /* 结果写在最上面「拍照建档」卡片里 —— 核对卡片这时已经被收起了 */
      this.setData({ recognizeStatus: msg, recognizeStatusType: 'is-ok' });
      wx.showToast({ title: '入库成功', icon: 'success' });
    } catch (err) {
      this.setData({
        saveStatus: (err && err.message) || '保存失败，请重试',
        saveStatusType: 'is-error',
      });
    } finally {
      this.setData({ saving: false });
    }
  },

  async resetAll() {
    const code = await db.generateCode();
    this.saleTouched = false;
    this.setData({
      photoPath: '',
      photoType: 'image/jpeg',
      hasPhoto: false,
      showReview: false,
      recognizeStatus: '',
      recognizeStatusType: '',
      saveStatus: '',
      saveStatusType: '',
      form: {
        code,
        name: '', brand: '', origin: '', material: '', spec: '', standard: '',
        channel: '', supplier: '', cost: '', sale: '',
        stock: String(DEFAULT_INITIAL_STOCK), note: '',
      },
    });
  },
});
