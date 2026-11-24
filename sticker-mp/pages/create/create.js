const app = getApp();
const db = require('../../utils/db');
const { cloud } = require('../../utils/cloud');
const { toNum, CHANNEL_OPTIONS, SUPPLIER_PRESETS } = require('../../utils/format');
const { describeDbError, describeStorageError, describeLlmError } = require('../../utils/errors');

const RECOGNIZE_SYSTEM = [
  '从商品照片提取标签信息。只输出一个 JSON 对象，不要解释文字或 Markdown 代码块。',
  '字段且仅含：name, brand, origin, material, spec, standard。',
  '值均为字符串；看不清的填空字符串，不要编造。',
].join('');

const RECOGNIZE_USER = '提取 name/brand/origin/material/spec/standard 六个字段，仅返回 JSON。';

/* 建档时的初始库存默认值：新到货多为单件样品，手动建档与识别建档统一按 1 件起 */
const DEFAULT_INITIAL_STOCK = 1;

/* 售价默认值 = 进价 × 0.66（进价人民币、售价美元；用户手动改过售价就不再自动覆盖） */
const SALE_DEFAULT_RATIO = 0.66;

/* 识别模型：2026-11-24 实测 deepseek-v4.1-flash 约 2.0s，auto 约 4.8s。
   按速度优先显式指定；候选缺失时按此顺序回退，不再默认命中 auto（推理型）。 */
const VISION_MODEL_PRIORITY = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'glm-5.3-flash',
  'fast-model',
  'space-bunny',
];

/* 识别模型缓存：v2 让旧缓存（auto）自动失效，无需用户手动清缓存 */
const MODEL_CACHE_KEY = 'sticker.visionModel.v2';
const MODEL_CACHE_TTL = 24 * 3600 * 1000;

/* 建议候选：60 秒内不重复拉全量商品，1 小时内复用本地缓存 */
const SUGGESTIONS_KEY = 'sticker.suggestions';
const SUGGESTIONS_TTL = 60 * 60 * 1000;
const SUGGESTIONS_THROTTLE = 60 * 1000;

/* 识别响应只填 6 个短字段，400 token 足够，避免模型多吐解释文字拖慢 */
const RECOGNIZE_MAX_TOKENS = 400;

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
    recognizeElapsed: 0,
    canCancel: false,
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
    this.refreshSuggestions(true);
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

    /* 先读缓存：24 小时内直接用，省掉 models.list 请求 */
    try {
      const cached = wx.getStorageSync(MODEL_CACHE_KEY);
      if (cached && cached.model && cached.model.id && cached.at && Date.now() - cached.at < MODEL_CACHE_TTL) {
        this.activeModel = cached.model;
        return cached.model;
      }
    } catch (e) { /* 缓存读不到就走网络 */ }

    const models = await cloud.llm.models.list();
    if (!models || models.length === 0) return null;
    const usable = models.filter((m) => m.disabled !== true && m.enabled !== false);
    const vision = usable.filter((m) => this.isVisionModel(m));
    if (vision.length === 0) return null;

    /* 速度优先：按实测优先级挑 flash 模型；目录改动导致候选缺失时逐级回退 */
    let picked = null;
    for (const id of VISION_MODEL_PRIORITY) {
      picked = vision.find((m) => m.id === id);
      if (picked) break;
    }
    if (!picked) picked = vision.find((m) => /flash|fast/i.test(String(m.id || ''))) || vision[0];
    this.activeModel = picked;
    try { wx.setStorageSync(MODEL_CACHE_KEY, { model: picked, at: Date.now() }); } catch (e) { /* 存不下就算了 */ }
    return picked;
  },

  clearModelCache() {
    this.activeModel = null;
    try { wx.removeStorageSync(MODEL_CACHE_KEY); } catch (e) { /* 忽略 */ }
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

  /* 直接读 shrinkPhoto 已压好的照片（实测平均仅 13~16KB），不再二次压缩。
     二次压缩要再等一次异步回调，省的 token 却几乎可以忽略，得不偿失。 */
  prepareImageDataUrl(path) {
    try {
      return 'data:image/jpeg;base64,' + wx.getFileSystemManager().readFileSync(path, 'base64');
    } catch (e) {
      return '';
    }
  },

  /* 识别期间可随时取消：流式循环里检查这个标记，break 会关闭流 */
  cancelRecognize() {
    if (!this.data.recognizing) return;
    this.cancelRequested = true;
    this.setData({ recognizeStatus: '正在取消…', recognizeStatusType: '' });
  },

  startRecognizeTimer() {
    this.stopRecognizeTimer();
    this.recognizeStartedAt = Date.now();
    this.recognizeTimer = setInterval(() => {
      if (this.cancelRequested) return;
      const s = (Date.now() - this.recognizeStartedAt) / 1000;
      this.setData({ recognizeElapsed: s, recognizeStatus: '模型识别中… ' + s.toFixed(1) + 's' });
    }, 500);
  },

  stopRecognizeTimer() {
    if (this.recognizeTimer) { clearInterval(this.recognizeTimer); this.recognizeTimer = null; }
  },

  async recognize() {
    if (!this.data.photoPath || this.data.recognizing) return;
    this.cancelRequested = false;
    this.setData({
      recognizing: true,
      canCancel: true,
      recognizeElapsed: 0,
      recognizeStatus: '正在准备照片…',
      recognizeStatusType: '',
      saveStatus: '',
      saveStatusType: '',
    });
    const t0 = Date.now();
    let preparedAt = 0, modelId = '', firstTokenAt = 0;
    try {
      const model = await this.pickVisionModel();
      if (!model) {
        this.setData({ recognizeStatus: '当前没有可用的识别模型，请稍后重试', recognizeStatusType: 'is-error' });
        return;
      }
      modelId = model.id;
      const dataUrl = this.prepareImageDataUrl(this.data.photoPath);
      if (!dataUrl) {
        this.setData({ recognizeStatus: '照片读取失败，请重新选择', recognizeStatusType: 'is-error' });
        return;
      }
      preparedAt = Date.now();

      /* 商品编码与模型推理并行发起，省一次串行数据库往返 */
      const codePromise = this.data.form.code
        ? Promise.resolve(this.data.form.code)
        : db.generateCode().catch(() => '');

      const params = {
        model: model.id,
        messages: [
          { role: 'system', content: RECOGNIZE_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: RECOGNIZE_USER },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        stream: true,
        max_tokens: RECOGNIZE_MAX_TOKENS,
      };
      /* 仅在模型声明支持 JSON 模式时才下发，避免不支持该参数的模型直接报错 */
      if (model.capabilities && model.capabilities.jsonMode === true) {
        params.response_format = { type: 'json_object' };
      }

      this.startRecognizeTimer();
      let buffer = '';
      const stream = await cloud.llm.chat.completions.create(params);
      for await (const chunk of stream) {
        if (this.cancelRequested) break;
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (delta && delta.content) {
          if (!firstTokenAt) {
            firstTokenAt = Date.now();
            this.stopRecognizeTimer();
            this.setData({ recognizeStatus: '已收到结果，正在整理…' });
          }
          buffer += delta.content;
        }
      }
      this.stopRecognizeTimer();

      if (this.cancelRequested) {
        this.setData({ recognizeStatus: '已取消识别', recognizeStatusType: '' });
        return;
      }

      const data = this.parseModelJson(buffer);
      const code = await codePromise;
      /* 分段计时打点，下次变慢能一眼看出卡在哪一段 */
      console.info('[create] recognize timing', {
        model: modelId,
        prepareMs: preparedAt - t0,
        firstTokenMs: firstTokenAt ? firstTokenAt - t0 : 0,
        totalMs: Date.now() - t0,
      });
      this.setData({
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
      /* 失败可能是缓存的模型已下线：清掉缓存，下次重新拉一份列表 */
      this.clearModelCache();
      this.setData({ recognizeStatus: describeLlmError(err), recognizeStatusType: 'is-error' });
    } finally {
      this.stopRecognizeTimer();
      this.cancelRequested = false;
      this.setData({ recognizing: false, canCancel: false });
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

  applySuggestions(v) {
    this.setData({
      suggestions: { brand: v.brand, supplier: v.supplierRange },
      channelRange: v.channelRange,
      /* 显示数组首项必须是「不填」，与 onChannelPick 的 idx0=清空 映射一致，
         否则会差一位：点「拼多多」被清空、点「小红书」选中「拼多多」 */
      channelLabels: ['不填'].concat(v.channelRange),
      supplierRange: v.supplierRange,
    });
  },

  async refreshSuggestions(force) {
    const now = Date.now();
    /* 60 秒内不重复拉（补上 P0 漏掉的建档页），下拉刷新可强制 */
    if (!force && this.lastSuggestionsAt && now - this.lastSuggestionsAt < SUGGESTIONS_THROTTLE) return;
    if (!force) {
      try {
        const cached = wx.getStorageSync(SUGGESTIONS_KEY);
        if (cached && cached.at && now - cached.at < SUGGESTIONS_TTL && cached.value) {
          this.applySuggestions(cached.value);
          this.lastSuggestionsAt = now;
          return;
        }
      } catch (e) { /* 读不到缓存就走网络 */ }
    }
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
      const value = { brand: uniq('brand'), channelRange, supplierRange };

      this.applySuggestions(value);
      this.lastSuggestionsAt = Date.now();
      try { wx.setStorageSync(SUGGESTIONS_KEY, { at: Date.now(), value }); } catch (e) { /* 存不下就算了 */ }
    } catch (e) { /* 候选失败不影响建档 */ }
  },

  /* ---------- 保存 ---------- */

  async save() {
    const f = this.data.form;
    /* 照片必选（要随商品保存），只有 AI 识别是可选步骤 */
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
      const imagePath = up.data.path;

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
        image_path: imagePath,
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
      /* 新建了商品 + 入库流水：库存 / 订单 / 报表三页下次进入必须重新拉 */
      app.markChanged();
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
