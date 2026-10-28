'use strict';

/* ============================================================
   贴纸进销存 — 前端主逻辑
   后端：WorkBuddy 云服务（数据库 / 文件存储 / 大模型 / 登录）
   ============================================================ */

if (typeof WorkBuddyCloud === 'undefined') {
  document.body.innerHTML =
    '<div style="padding:60px 20px;text-align:center;color:#6b7280;font-size:14px">' +
    'SDK 加载失败，请检查网络后刷新页面</div>';
  throw new Error('WorkBuddy Cloud SDK not loaded');
}

const publicConfig = {
  endpoint: 'https://sticker-inventory.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_O8jLJIabPTnWmTRC3CxhH7_aQfiCNsk2b65HK6ofU0v1YT6M2cdfgdW',
};

/* ============================================================
   网关 CORS 兼容补丁（照片上传必需）
   ------------------------------------------------------------
   现象：上传照片时报「Failed to fetch」。
   原因：SDK 会在请求上附加若干自定义头，但本环境网关的
        Access-Control-Allow-Headers 只放行
          Authorization / X-Wb-Webapp-Access-Key / Content-Type /
          Accept / Prefer / Range / Content-Range / If-Match /
          If-None-Match / X-Request-Id / X-Device-Id / X-Wb-Webapp-Language
        以下 4 个头不在其中，浏览器预检（OPTIONS）会被拒，
        fetch 在发出真实请求前就抛 TypeError: Failed to fetch：

          X-Client-Info    存储模块的每个请求都带
          x-upsert         存储「上传/覆盖」时无条件附加
          X-Conversation-ID 大模型指定会话时附加
          X-Retry-Count    数据库请求发生重试时才附加

   处理：在请求发往云服务时剔除这 4 个头。它们在本应用里都不承载
        业务语义——X-Client-Info 只是客户端标识；x-upsert 只在覆盖
        同名对象时才有意义，而我们的文件名是 UUID，不存在同名覆盖；
        会话分组与重试计数本就无法从浏览器送出（CORS 已拦），
        剔除后行为与现状完全一致，只是不再被预检挡下。

   注意：必须在 createWorkBuddyCloud() 之前打补丁，
        因为 SDK 在构造客户端时就绑定了 globalThis.fetch。
   ============================================================ */
(function patchCloudFetchHeaders() {
  const BLOCKED_HEADERS = ['x-client-info', 'x-upsert', 'x-conversation-id', 'x-retry-count'];
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (init && init.headers && url.indexOf(publicConfig.endpoint) === 0) {
        const headers = new Headers(init.headers);
        let changed = false;
        BLOCKED_HEADERS.forEach(function (name) {
          if (headers.has(name)) {
            headers.delete(name);
            changed = true;
          }
        });
        if (changed) init = Object.assign({}, init, { headers });
      }
    } catch (e) {
      /* 补丁异常时保持原样，不影响主流程 */
    }
    return nativeFetch(input, init);
  };
})();

const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
});

/* ================= 基础工具 ================= */

const $ = (id) => document.getElementById(id);
const LOW_STOCK_AT = 5;

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function fmtMoney(value) {
  const n = Number(value);
  return '¥' + (Number.isFinite(n) ? n.toFixed(2) : '0.00');
}

/* 售价 / 成交单价记的是美元，单独一套符号，
   免得界面上一堆数字看不出哪个是人民币、哪个是美元 */
function fmtUsd(value) {
  const n = Number(value);
  return '$' + (Number.isFinite(n) ? n.toFixed(2) : '0.00');
}

/* 没填的价格显示成「未填」而不是 ¥0.00 —— 0 元和没填是两回事 */
function moneyOrDash(value) {
  return value == null || value === '' ? '<span class="dash">未填</span>' : fmtMoney(value);
}
function usdOrDash(value) {
  return value == null || value === '' ? '<span class="dash">未填</span>' : fmtUsd(value);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 时间缺失时用短横线占位，避免出现空白 */
function fmtTimeOrDash(iso) {
  const t = fmtTime(iso);
  return t ? esc(t) : '<span class="dash">—</span>';
}

function maskPhone(p) {
  const s = String(p || '');
  return s.length >= 11 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function emptyEl(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function setStatus(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function showView(name) {
  $('bootView').classList.toggle('hidden', name !== 'boot');
  $('loginView').classList.toggle('hidden', name !== 'login');
  $('appView').classList.toggle('hidden', name !== 'app');
}

function describeDbError(error) {
  if (!error) return '未知错误';
  // 错误码可能带前缀（如 DATABASE_23505），用包含判断更稳
  const code = String((error && error.code) || '');
  const raw = String((error && error.message) || '');
  const has = (n) => code.indexOf(n) >= 0 || raw.indexOf(n) >= 0;
  if (has('23505')) return '产品编码已存在，请换一个';
  if (has('42501')) return '没有权限执行该操作，请确认已登录';
  if (has('42P01')) return '数据表不存在，请重新初始化环境';
  return raw || '数据库操作失败';
}

/* 存储写失败时给出可判断原因，而不是只丢一句 "Failed to fetch" */
function describeStorageError(error) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.code) || '');

  if (code === 'MISSING_CREDENTIALS' || code === 'UNAUTHORIZED') {
    return '登录状态已失效，请退出后重新登录再试';
  }
  if (!msg || /failed to fetch|network|load failed/i.test(msg)) {
    return '网络请求未能送达（跨源限制或网络异常），请检查网络后重试';
  }
  return msg + (code ? '（' + code + '）' : '');
}

/* ================= 视图：Tab ================= */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === name);
  });
  ['create', 'inventory', 'moves', 'orders', 'report'].forEach((n) => {
    $('panel-' + n).classList.toggle('hidden', n !== name);
  });
  if (name === 'inventory') loadInventory();
  if (name === 'moves') { renderOrderFilterTag(); renderMoveKindSeg(); loadMoves(); }
  if (name === 'orders') loadOrders();
  if (name === 'report') loadReport();
}

/* ================= 登录：手机号验证码 ================= */

let pendingOtp = null;
let resendTimer = null;

function onPhoneInput() {
  $('phoneError').textContent = '';
}

function startResendCountdown() {
  const btn = $('sendCodeBtn');
  let left = 60;
  btn.disabled = true;
  btn.textContent = left + 's 后重发';
  clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(resendTimer);
      btn.disabled = false;
      btn.textContent = '获取验证码';
    } else {
      btn.textContent = left + 's 后重发';
    }
  }, 1000);
}

async function sendCode() {
  const phone = $('phoneInput').value.trim();
  $('loginError').textContent = '';

  if (!/^1\d{10}$/.test(phone)) {
    $('phoneError').textContent = '请输入正确的 11 位手机号';
    return;
  }
  $('phoneError').textContent = '';

  const btn = $('sendCodeBtn');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const sent = await cloud.auth.sendOtp({ phone });
    if (sent.error) {
      $('loginError').textContent = sent.error.message || '验证码发送失败';
      btn.disabled = false;
      btn.textContent = '获取验证码';
      return;
    }
    pendingOtp = { phone, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser };
    startResendCountdown();
    toast('验证码已发送');
  } catch (err) {
    $('loginError').textContent = '验证码发送失败，请稍后重试';
    btn.disabled = false;
    btn.textContent = '获取验证码';
  }
}

async function doLogin() {
  const phone = $('phoneInput').value.trim();
  const token = $('codeInput').value.trim();
  $('loginError').textContent = '';

  if (!pendingOtp || pendingOtp.phone !== phone) {
    $('loginError').textContent = '请先获取该手机号的验证码';
    return;
  }
  if (!/^\d{4,6}$/.test(token)) {
    $('loginError').textContent = '请输入收到的验证码';
    return;
  }

  const btn = $('loginBtn');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const done = await cloud.auth.verifyOtp({
      phone: pendingOtp.phone,
      verificationId: pendingOtp.verificationId,
      isExistingUser: pendingOtp.isExistingUser,
      token,
    });
    if (done.error) {
      $('loginError').textContent = done.error.message || '验证码不正确，请重试';
      return;
    }
    pendingOtp = null;
    clearInterval(resendTimer);
    await enterApp();
  } catch (err) {
    $('loginError').textContent = '登录失败，请稍后重试';
  } finally {
    btn.disabled = false;
    btn.textContent = '登录 / 注册';
  }
}

async function enterApp() {
  const { data: session } = await cloud.auth.getSession();
  if (!session) { showView('login'); return; }
  const rawPhone = session.user && (session.user.phone || session.user.phoneNumber);
  $('userPhone').textContent = rawPhone ? maskPhone(rawPhone) : '已登录';
  showView('app');
  switchTab('create');
  // 汇率与品牌候选都需要登录态（RLS 按 owner 过滤），进应用后并行预热
  usdCnyRate = await loadRate();
  renderRateBtn();
  refreshBrandOptions();
}

/* ================= 汇率与设置 =================
   进价记人民币、售价记美元，订单金额与报表都要折成人民币才能和成本相减。
   整站只有一个汇率，存在云数据库 app_settings 里（换设备也一致）。
   ============================================== */

const DEFAULT_USD_CNY = 7.2;
const RATE_KEY = 'usd_cny_rate';
let usdCnyRate = DEFAULT_USD_CNY;

function rateOf() {
  const n = Number(usdCnyRate);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_CNY;
}

function fmtRate() { return rateOf().toFixed(2); }

async function loadRate() {
  try {
    const { data, error } = await cloud.database
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', RATE_KEY)
      .maybeSingle();
    if (error || !data) return DEFAULT_USD_CNY;
    const n = Number(data.setting_value);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_CNY;
  } catch (e) {
    return DEFAULT_USD_CNY;   // 取不到就用默认值，不挡主流程
  }
}

async function saveRate(value) {
  const payload = {
    setting_key: RATE_KEY,
    setting_value: String(value),
    updated_at: new Date().toISOString(),
  };
  const upd = await cloud.database.from('app_settings')
    .update(payload).eq('setting_key', RATE_KEY).select();
  if (upd.error) return upd.error;
  if (!Array.isArray(upd.data) || upd.data.length === 0) {
    const ins = await cloud.database.from('app_settings').insert(payload).select();
    if (ins.error) return ins.error;
    if (!Array.isArray(ins.data) || ins.data.length === 0) return { message: '保存失败，请重试' };
  }
  return null;
}

function renderRateBtn() {
  const btn = $('rateBtn');
  if (!btn) return;
  btn.textContent = '$1 ≈ ¥' + fmtRate();
  btn.title = '美元兑人民币汇率，点击修改（售价按 $ 折算成 ¥ 参与利润计算）';
}

function openRateDialog() {
  const body =
    '<p class="hint">售价与成交单价记的是美元，进价记的是人民币。' +
    '订单金额、统计报表都按这个汇率把美元折成人民币，再减去人民币成本算利润。</p>' +
    '<label class="field"><span>1 美元 = 多少人民币</span>' +
      '<input id="rateInput" type="number" min="0.01" step="0.01" value="' + fmtRate() + '"></label>';

  openModal('美元兑人民币汇率', body, async () => {
    const v = Number($('rateInput').value);
    if (!Number.isFinite(v) || v <= 0) {
      $('modalError').textContent = '请填写大于 0 的汇率';
      return true;
    }
    const err = await saveRate(v);
    if (err) { $('modalError').textContent = describeDbError(err); return true; }
    usdCnyRate = v;
    renderRateBtn();
    toast('汇率已更新为 $1 ≈ ¥' + fmtRate());
    renderMoves();    // 流水页的订单结算卡跟着重算
    renderOrders();   // 订单管理页
    if ($('panel-report') && !$('panel-report').classList.contains('hidden')) renderReport();
    return false;
  });
}

/* ================= 图片处理 ================= */

async function compressImage(file, maxSide, quality) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (bitmap.close) bitmap.close();
  if (!blob) throw new Error('图片压缩失败');
  return blob;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

/* ================= 商品建档 ================= */

let currentPhoto = null;
let activeModel = null;

async function onFileChosen(file) {
  if (!file) return;
  if (!file.type || !file.type.startsWith('image/')) { toast('请选择图片文件'); return; }
  if (file.size > 12 * 1024 * 1024) { toast('图片过大，请选择 12MB 以内的照片'); return; }
  try {
    const blob = await compressImage(file, 1024, 0.82);
    const dataUrl = await blobToDataUrl(blob);
    currentPhoto = { blob, dataUrl };
    $('previewImg').src = dataUrl;
    $('previewImg').classList.remove('hidden');
    $('uploadPlaceholder').classList.add('hidden');
    $('recognizeBtn').disabled = false;
    $('reviewCard').classList.add('hidden');
    setStatus('recognizeStatus', '');
  } catch (err) {
    toast('图片处理失败，请换一张试试');
  }
}

/* ---------- 照片拖拽：把文件直接拖进上传框就能建档，省掉「点开文件夹找图」 ---------- */

const DROP_HINT_DEFAULT = '也可以把照片直接拖进来';
const DROP_HINT_ACTIVE = '松手就能用这张照片';

/* 建档时的初始库存默认值：新到货多为单件样品，手动建档与识别建档统一按 1 件起 */
const DEFAULT_INITIAL_STOCK = 1;
/* 进货渠道固定选项（下拉选）；进货商预置项（可下拉选也可手填）。
   历史数据里出现过的值会自动追加到选项后面，保证旧值仍能选中 */
const CHANNEL_OPTIONS = ['拼多多', '小红书', '1688', '抖音'];
const SUPPLIER_PRESETS = ['悠米', '小时光'];

function dtHasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.from(dt.types).indexOf('Files') >= 0) return true;
  return !!(dt.files && dt.files.length);
}

function bindPhotoDropZone() {
  const zone = $('uploadZone');
  if (!zone) return;

  let depth = 0;   // 指针掠过子元素会反复触发 enter / leave，用计数防止高亮闪烁

  const clear = () => {
    depth = 0;
    zone.classList.remove('is-dragover');
    const hint = $('dropHint');
    if (hint) hint.textContent = DROP_HINT_DEFAULT;
  };
  const glow = () => {
    zone.classList.add('is-dragover');
    const hint = $('dropHint');
    if (hint) hint.textContent = DROP_HINT_ACTIVE;
  };

  zone.addEventListener('dragenter', (e) => {
    if (!dtHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth += 1;
    glow();
  });

  zone.addEventListener('dragover', (e) => {
    if (!dtHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    glow();
  });

  zone.addEventListener('dragleave', (e) => {
    if (!dtHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth -= 1;
    if (depth <= 0) clear();
  });

  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    clear();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const images = files.filter((f) => f.type && f.type.startsWith('image/'));
    if (!images.length) {
      toast(files.length ? '只能拖入图片文件（jpg / png / webp 等）' : '没读到图片，请重新拖一次');
      return;
    }
    if (images.length > 1) toast('一次建档只用一张图，已取第一张');
    await onFileChosen(images[0]);
  });

  // 拖到页面其他位置时别让浏览器直接把图片打开、把当前页面顶掉
  ['dragover', 'drop'].forEach((type) => {
    document.addEventListener(type, (e) => {
      if (zone.contains(e.target)) return;
      e.preventDefault();
    });
  });
  // 拖出浏览器窗口时收起高亮
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) clear(); });
  window.addEventListener('blur', clear);
}

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

function isVisionModel(m) {
  if (!m) return false;
  if (m.supportsImages === true) return true;
  if (m.capabilities && m.capabilities.vision === true) return true;
  if (m.modalities && Array.isArray(m.modalities.input)) {
    return m.modalities.input.indexOf('image') >= 0;
  }
  return false;
}

async function pickVisionModel() {
  const models = await cloud.llm.models.list();
  if (!models || models.length === 0) return null;
  const usable = models.filter((m) => m.disabled !== true && m.enabled !== false);
  const vision = usable.filter(isVisionModel);
  if (vision.length === 0) return null;
  // 优先官方默认模型（已做过效果与成本平衡），其次支持 JSON 模式，最后取第一个
  return vision.find((m) => m.isDefault === true)
    || vision.find((m) => m.capabilities && m.capabilities.jsonMode === true)
    || vision[0];
}

function parseModelJson(text) {
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
}

function describeLlmError(err) {
  const code = String((err && err.error && err.error.code) || '');
  if (code.indexOf('quota_') === 0) return 'AI 额度不足或触发限流，请稍后再试';
  if (code.indexOf('auth_') === 0) return 'AI 服务鉴权失败，请确认在正式域名下访问';
  if (code.indexOf('request_') === 0) return '识别请求参数有误，请换一张照片重试';
  if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return '模型服务暂时不可用，请重试';
  return '识别失败，请稍后重试';
}

async function recognize() {
  if (!currentPhoto) return;
  const btn = $('recognizeBtn');
  btn.disabled = true;
  setStatus('recognizeStatus', '正在调用大模型识别，请稍候…');
  try {
    if (!activeModel) activeModel = await pickVisionModel();
    if (!activeModel) {
      setStatus('recognizeStatus', '当前没有可用的识别模型，请稍后重试', 'is-error');
      return;
    }
    let buffer = '';
    // ModelHub 硬约束：首条消息必须是 system；且只支持流式
    const params = {
      model: activeModel.id,
      messages: [
        { role: 'system', content: RECOGNIZE_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: RECOGNIZE_USER },
            { type: 'image_url', image_url: { url: currentPhoto.dataUrl } },
          ],
        },
      ],
      stream: true,
    };
    // 仅在模型声明支持 JSON 模式时才下发，避免不支持该参数的模型直接报错
    if (activeModel.capabilities && activeModel.capabilities.jsonMode === true) {
      params.response_format = { type: 'json_object' };
    }

    for await (const chunk of cloud.llm.chat.completions.create(params)) {
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (delta && delta.content) buffer += delta.content;
    }
    fillReviewForm(parseModelJson(buffer));
    $('reviewCard').classList.remove('hidden');
    setStatus('recognizeStatus', '识别完成，请核对下方信息', 'is-ok');
    $('reviewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus('recognizeStatus', describeLlmError(err), 'is-error');
  } finally {
    btn.disabled = false;
  }
}

/* 生成产品编码：SP + 年月日 + 3 位当日序号
   序号取「当天已用编码里的最大序号 + 1」，不能按当天商品条数来算——
   条数会随商品被删除而回退，导致新商品拿到已用过的编码。
   数据库侧另有 UNIQUE(owner_id, code) 约束兜底。 */
async function generateCode() {
  const now = new Date();
  const stamp = '' + now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const prefix = 'SP' + stamp;

  let maxSeq = 0;
  try {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const res = await cloud.database
      .from('products')
      .select('code')
      .gte('created_at', startOfDay);
    if (!res.error && Array.isArray(res.data)) {
      res.data.forEach((row) => {
        const m = String((row && row.code) || '').match(/^SP(\d{8})(\d+)$/);
        if (m && m[1] === stamp) {
          const n = parseInt(m[2], 10);
          if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
        }
      });
    }
  } catch (e) { /* 查询失败时从 001 起，由唯一约束兜底 */ }

  return prefix + String(maxSeq + 1).padStart(3, '0');
}

/* 售价默认值 = 进价 × 0.66（进价人民币、售价美元；用户手动改过售价就不再自动覆盖） */
const SALE_DEFAULT_RATIO = 0.66;
let saleManuallyEdited = false;

function autoFillSaleFromCost() {
  if (saleManuallyEdited) return;
  const raw = $('fCost').value.trim();
  const cost = Number(raw);
  $('fSale').value =
    raw === '' || !isFinite(cost) || cost < 0
      ? ''
      : String(Math.round(cost * SALE_DEFAULT_RATIO * 100) / 100);
}

async function fillReviewForm(data) {
  $('fName').value = data.name || '';
  $('fBrand').value = data.brand || '';
  $('fOrigin').value = data.origin || '';
  $('fMaterial').value = data.material || '';
  $('fSpec').value = data.spec || '';
  $('fStandard').value = data.standard || '';
  // 进价填入后售价按 进价×0.66 自动带出；这里先留空
  $('fCost').value = '';
  $('fSale').value = '';
  saleManuallyEdited = false;
  // 初始库存同样是默认 1 件，和手动建档保持一致
  $('fStock').value = String(DEFAULT_INITIAL_STOCK);
  $('fNote').value = '';
  setStatus('saveStatus', '');
  // 产品编码不在表单中显示，保存时自动生成
}

function resetCreate() {
  currentPhoto = null;
  $('fileInput').value = '';
  $('previewImg').src = '';
  $('previewImg').classList.add('hidden');
  $('uploadPlaceholder').classList.remove('hidden');
  $('uploadZone').classList.remove('is-dragover');
  if ($('dropHint')) $('dropHint').textContent = DROP_HINT_DEFAULT;
  $('recognizeBtn').disabled = true;
  $('reviewCard').classList.add('hidden');
  setStatus('recognizeStatus', '');
  setStatus('saveStatus', '');
  ['fName', 'fBrand', 'fOrigin', 'fMaterial', 'fSpec', 'fStandard',
    'fChannel', 'fSupplier', 'fNote']
    .forEach((id) => { $(id).value = ''; });
  // 价格留空由用户自己填（进价人民币 / 售价美元），库存默认 1 件
  $('fCost').value = '';
  $('fSale').value = '';
  saleManuallyEdited = false;
  $('fStock').value = String(DEFAULT_INITIAL_STOCK);
}

async function saveProduct() {
  if (!currentPhoto) { toast('请先选择商品照片'); return; }
  const name = $('fName').value.trim();
  if (!name) { setStatus('saveStatus', '请填写产品名称', 'is-error'); return; }
  // 进价 / 售价必填：非空且为非负数字
  const rawCost = $('fCost').value.trim();
  const rawSale = $('fSale').value.trim();
  if (rawCost === '' || !isFinite(Number(rawCost)) || Number(rawCost) < 0) {
    setStatus('saveStatus', '请填写有效的进价（人民币 ¥）', 'is-error');
    return;
  }
  if (rawSale === '' || !isFinite(Number(rawSale)) || Number(rawSale) < 0) {
    setStatus('saveStatus', '请填写有效的售价（美元 $）', 'is-error');
    return;
  }

  const btn = $('saveProductBtn');
  btn.disabled = true;
  setStatus('saveStatus', '正在保存…');

  try {
    const { data: session } = await cloud.auth.getSession();
    if (!session) {
      setStatus('saveStatus', '登录已失效，请重新登录', 'is-error');
      showView('login');
      return;
    }

    const path = cloud.storage.userPath(session.user.id, 'products/' + crypto.randomUUID() + '.jpg');
    const up = await cloud.storage.upload(path, currentPhoto.blob, { contentType: 'image/jpeg' });
    if (up && up.error) throw new Error('照片上传失败：' + describeStorageError(up.error));

    const stock = Math.max(0, Math.round(toNum($('fStock').value)));
    // 进价 / 售价已在校验时确保非空
    const payload = {
      code: await generateCode(),
      name,
      brand: $('fBrand').value.trim() || null,
      origin: $('fOrigin').value.trim() || null,
      material: $('fMaterial').value.trim() || null,
      spec: $('fSpec').value.trim() || null,
      standard: $('fStandard').value.trim() || null,
      purchase_channel: $('fChannel').value.trim() || null,
      supplier_name: $('fSupplier').value.trim() || null,
      image_path: path,
      cost_price: toNum(rawCost),
      sale_price: toNum(rawSale),
      stock,
      note: $('fNote').value.trim() || null,
      // 建档即为首次入库，初始库存为 0 时不算入库
      last_in_at: stock > 0 ? new Date().toISOString() : null,
    };

    // 编码若与已有商品冲突（并发录入 / 手动填了重复值），自动换新编码重试，最多 3 次
    let created = null;
    let finalCode = payload.code;
    let codeChanged = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ins = await cloud.database
        .from('products')
        .insert(Object.assign({}, payload, { code: finalCode }))
        .select();
      if (!ins.error) {
        created = Array.isArray(ins.data) ? ins.data[0] : null;
        break;
      }
      const rawCode = String((ins.error && ins.error.code) || '');
      const rawMsg = String((ins.error && ins.error.message) || '');
      const isConflict = rawCode.indexOf('23505') >= 0 || rawMsg.indexOf('23505') >= 0;
      if (!isConflict) throw new Error(describeDbError(ins.error));
      finalCode = await generateCode();
      codeChanged = true;
    }
    if (!created) throw new Error('产品编码连续重复，请稍后重试');

    if (stock > 0) {
      const mv = await cloud.database.from('stock_moves').insert({
        product_id: created.id,
        move_type: 'in',
        quantity: stock,
        unit_price: toNum(payload.cost_price),
      });
      if (mv.error) {
        setStatus('saveStatus', '商品已保存，但入库流水写入失败：' + describeDbError(mv.error), 'is-error');
        return;
      }
    }

    const resultMsg = '已入库：' + created.name + '（' + created.code + '）' +
      (codeChanged ? ' · 原编码已被占用，已自动分配新编码' : '');
    // 先重置表单，再把结果写到上方始终可见的状态区
    //（写在审核卡片里会被重置动作一起清掉，用户看不到）
    resetCreate();
    setStatus('recognizeStatus', resultMsg, 'is-ok');
    toast('入库成功');
  } catch (err) {
    setStatus('saveStatus', (err && err.message) || '保存失败，请重试', 'is-error');
  } finally {
    btn.disabled = false;
  }
}

/* ================= 库存列表 / 品牌 ================= */

let inventoryCache = [];

/* 品牌不是单独维护的表，而是从已录入商品里自动汇总出来的 */
const ALL_BRANDS = '__all__';
const NO_BRAND = '__none__';
let brandFilter = ALL_BRANDS;

/* 归档视图：false 看在售商品（默认），true 只看已归档商品。
   归档 = 停售但保留历史：流水、订单、报表不受影响，可随时恢复 */
let archivedView = false;

function isVisible(p) {
  return !!p.archived === archivedView;
}

function archivedCount() {
  return inventoryCache.filter((p) => !!p.archived).length;
}

/* 切换按钮的文字与样式跟着视图走 */
function syncArchivedToggle() {
  const btn = $('archivedToggleBtn');
  if (!btn) return;
  const n = archivedCount();
  btn.textContent = archivedView ? '返回在售' : ('已归档' + (n > 0 ? ' (' + n + ')' : ''));
  btn.className = (archivedView ? 'blue' : 'ghost') + ' small';
  btn.title = archivedView ? '回到在售商品列表' : '查看已归档（停售）的商品';
}

function brandKeyOf(p) {
  const b = String((p && p.brand) || '').trim();
  return b || NO_BRAND;
}

/* 聚合出「品牌信息」：每个品牌下的商品数与库存总数（只统计当前归档视图下的商品） */
function buildBrandStats() {
  const map = new Map();
  inventoryCache.forEach((p) => {
    if (!isVisible(p)) return;
    const key = brandKeyOf(p);
    let s = map.get(key);
    if (!s) {
      s = { key, name: key === NO_BRAND ? '未标注品牌' : key, count: 0, stock: 0 };
      map.set(key, s);
    }
    s.count += 1;
    s.stock += Number(p.stock) || 0;
  });
  const list = Array.from(map.values());
  list.sort((a, b) => {
    if (a.key === NO_BRAND) return 1;   // 未标注品牌固定排最后
    if (b.key === NO_BRAND) return -1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return list;
}

async function loadInventory() {
  const box = $('inventoryList');
  box.innerHTML = '';
  box.appendChild(emptyEl('加载中…'));
  try {
    const { data, error } = await cloud.database
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      box.innerHTML = '';
      box.appendChild(emptyEl(describeDbError(error)));
      return;
    }
    inventoryCache = Array.isArray(data) ? data : [];
    // 选中的品牌若已不存在（商品被删除或改了品牌），自动回到「全部商品」
    if (brandFilter !== ALL_BRANDS && !buildBrandStats().some((s) => s.key === brandFilter)) {
      brandFilter = ALL_BRANDS;
    }
    syncArchivedToggle();
    renderBrandSidebar();
    renderInventory();
    hydrateThumbs();
    refreshBrandOptions();
  } catch (err) {
    box.innerHTML = '';
    box.appendChild(emptyEl('加载失败，请重试'));
  }
}

function renderBrandSidebar() {
  const box = $('brandSidebar');
  if (!box) return;
  const stats = buildBrandStats();

  box.innerHTML = '';
  const title = document.createElement('p');
  title.className = 'brand-sidebar-title';
  title.textContent = '品牌';
  box.appendChild(title);

  const items = [{ key: ALL_BRANDS, name: '全部商品', count: inventoryCache.length }]
    .concat(stats);

  const frag = document.createDocumentFragment();
  items.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'brand-item' + (s.key === brandFilter ? ' is-active' : '');
    btn.dataset.brand = s.key;
    if (s.key !== ALL_BRANDS) {
      btn.title = s.name + ' · ' + s.count + ' 款商品 · 库存 ' + s.stock + ' 件';
    }
    const name = document.createElement('span');
    name.className = 'brand-name';
    name.textContent = s.name;
    const count = document.createElement('span');
    count.className = 'brand-count';
    count.textContent = String(s.count);
    btn.appendChild(name);
    btn.appendChild(count);
    frag.appendChild(btn);
  });
  box.appendChild(frag);
}

function renderInventory() {
  const box = $('inventoryList');
  const keyword = $('searchInput').value.trim().toLowerCase();
  const rows = inventoryCache.filter((p) => {
    if (!isVisible(p)) return false;
    if (brandFilter !== ALL_BRANDS && brandKeyOf(p) !== brandFilter) return false;
    if (!keyword) return true;
    return [p.name, p.code, p.brand]
      .some((v) => String(v == null ? '' : v).toLowerCase().indexOf(keyword) >= 0);
  });

  box.innerHTML = '';
  if (rows.length === 0) {
    box.appendChild(emptyEl(inventoryEmptyText(keyword)));
  } else {
    const frag = document.createDocumentFragment();
    rows.forEach((p) => frag.appendChild(inventoryItem(p)));
    box.appendChild(frag);
  }
  updateInventoryCount(rows.length);
}

function inventoryEmptyText(keyword) {
  if (inventoryCache.length === 0) return '还没有商品，先去「商品建档」录一个';
  if (archivedView) return keyword ? '归档商品里没有匹配的' : '还没有归档的商品';
  if (keyword) return '没有匹配的商品';
  return '该品牌下暂无商品';
}

function updateInventoryCount(shown) {
  const el = $('inventoryCount');
  if (!el) return;
  const total = inventoryCache.length;
  if (total === 0) { el.textContent = ''; return; }
  const filtered = brandFilter !== ALL_BRANDS || !!$('searchInput').value.trim();
  let text = filtered
    ? '筛选出 ' + shown + ' 款 / 共 ' + total + ' 款商品'
    : '共 ' + total + ' 款商品';
  const archived = archivedCount();
  if (!archivedView && archived > 0) text += ' · 另有 ' + archived + ' 款已归档';
  el.textContent = text;
}

/* 品牌 / 进货渠道 / 进货商候选：都从已录入商品自动汇总，建档/编辑时可直接选，
   避免同一家出现「3M」「3m」或「义乌XX」两种写法 */
function fillDatalist(id, values) {
  const list = $(id);
  if (!list) return;
  list.innerHTML = '';
  values.forEach((n) => {
    const opt = document.createElement('option');
    opt.value = n;
    list.appendChild(opt);
  });
}

/* 渠道下拉的选项串：不填 + 固定四项 + 历史值 + 当前值（旧值不在列表时也要能选中） */
let channelHistoryCache = [];
function channelOptionsHtml(current) {
  const cur = String(current || '');
  const opts = [''];
  CHANNEL_OPTIONS.forEach((v) => { if (!opts.includes(v)) opts.push(v); });
  channelHistoryCache.forEach((v) => { if (!opts.includes(v)) opts.push(v); });
  if (cur && !opts.includes(cur)) opts.push(cur);
  return opts.map((v) =>
    '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>'
    + (v === '' ? '不填' : esc(v)) + '</option>'
  ).join('');
}

/* 预置项 + 历史值合并（预置在前，历史去重追加） */
function mergePresets(presets, history) {
  return presets.concat(history.filter((v) => !presets.includes(v)));
}

async function refreshBrandOptions() {
  if (!$('brandOptions')) return;
  try {
    const res = await cloud.database.from('products')
      .select('brand, purchase_channel, supplier_name');
    if (res.error || !Array.isArray(res.data)) return;
    const uniq = (field) => Array.from(new Set(
      res.data.map((r) => String((r && r[field]) || '').trim()).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    fillDatalist('brandOptions', uniq('brand'));
    fillDatalist('supplierOptions', mergePresets(SUPPLIER_PRESETS, uniq('supplier_name')));

    /* 渠道是 <select>：历史值动态并入选项，已选中的值保持不变 */
    channelHistoryCache = uniq('purchase_channel');
    ['fChannel', 'eChannel'].forEach((id) => {
      const sel = $(id);
      if (sel) sel.innerHTML = channelOptionsHtml(sel.value);
    });
  } catch (e) { /* 候选失败不影响建档 */ }
}

function inventoryItem(p) {
  const stock = Number(p.stock) || 0;
  const badge = p.archived
    ? '<span class="badge archived">已归档</span>'
    : (stock <= 0
      ? '<span class="badge out">缺货</span>'
      : (stock <= LOW_STOCK_AT ? '<span class="badge low">库存偏低</span>' : ''));

  const detail = [
    p.brand ? '品牌 ' + esc(p.brand) : '',
    p.origin ? '产地 ' + esc(p.origin) : '',
    p.material ? '材质 ' + esc(p.material) : '',
    p.spec ? '规格 ' + esc(p.spec) : '',
    p.standard ? '执行标准 ' + esc(p.standard) : '',
  ].filter(Boolean).join(' · ') || '—';

  // 进货信息（渠道 / 进货商）：选填，没登记就显示「—」
  const source = [
    p.purchase_channel ? '渠道 ' + esc(p.purchase_channel) : '',
    p.supplier_name ? '进货商 ' + esc(p.supplier_name) : '',
  ].filter(Boolean).join(' · ') || '—';

  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML =
    '<div class="item-thumb placeholder" data-thumb="' + esc(p.image_path || '') + '">照片</div>' +
    '<div class="item-main">' +
      '<p class="item-title">' + esc(p.name) + badge + '</p>' +
      '<p class="item-code">' + esc(p.code || '') + '</p>' +
      '<p class="item-meta">库存 <b>' + stock + '</b> · 进价 <b>' + moneyOrDash(p.cost_price) +
        '</b> · 售价 <b>' + usdOrDash(p.sale_price) + '</b></p>' +
      '<p class="item-meta">入库 <b>' + fmtTimeOrDash(p.last_in_at) +
        '</b> · 出库 <b>' + fmtTimeOrDash(p.last_out_at) + '</b></p>' +
      '<p class="item-meta item-source">进货 ' + source + '</p>' +
      '<p class="item-meta">' + detail + '</p>' +
    '</div>' +
    '<div class="item-actions">' +
      (p.archived
        ? '<button type="button" class="primary small" data-act="restore" data-id="' + p.id + '">恢复上架</button>' +
          '<button type="button" class="ghost small" data-act="edit" data-id="' + p.id + '">编辑</button>'
        : (stock <= 0
          ? '<button type="button" class="primary small" data-act="out" data-id="' + p.id +
            '" disabled title="缺货，请先补货">出库销售</button>'
          : '<button type="button" class="primary small" data-act="out" data-id="' + p.id + '">出库销售</button>') +
          '<button type="button" class="small ' + (stock <= 0 ? 'blue urge' : 'ghost') +
            '" data-act="in" data-id="' + p.id + '">补货</button>' +
          '<button type="button" class="ghost small" data-act="edit" data-id="' + p.id + '">编辑</button>' +
          '<button type="button" class="ghost small" data-act="archive" data-id="' + p.id +
            '" title="停售并从库存列表隐藏，历史流水与报表保留">归档</button>') +
    '</div>';
  return el;
}

async function hydrateThumbs() {
  const thumbs = Array.prototype.slice.call(document.querySelectorAll('[data-thumb]'));
  const paths = thumbs.map((t) => t.dataset.thumb).filter(Boolean);
  if (paths.length === 0) return;
  try {
    const res = await cloud.storage.createSignedUrls(paths, 3600);
    if (res.error || !res.data) return;
    const map = {};
    (Array.isArray(res.data) ? res.data : []).forEach((item) => {
      const url = item.signedUrl || item.signedURL || item.url;
      const key = item.path || item.pathname;
      if (key && url) map[key] = url;
    });
    thumbs.forEach((t) => {
      const url = map[t.dataset.thumb];
      if (!url) return;
      const img = document.createElement('img');
      img.className = 'item-thumb';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = url;
      t.replaceWith(img);
    });
  } catch (e) { /* 缩略图失败不影响主流程 */ }
}

/* ================= 订单出库会话 =================
   一次「开始出库 → 逐件出库 → 出库结束」之间的出库，
   全部记到同一个订单号下（流水表 stock_moves.order_no）。
   输入新订单号再点「开始出库」，会自动结束上一个订单并切换。
   会话状态存 localStorage：正在为某订单出库时刷新页面很常见，
   丢了状态会让后续商品悄悄记到无订单的流水里。
   ================================================ */

const ACTIVE_ORDER_KEY = 'sticker.activeOrder';

let activeOrder = null;   // { no, buyerName, startedAt, qty, moves, amount }

function loadActiveOrder() {
  try {
    const raw = localStorage.getItem(ACTIVE_ORDER_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && typeof obj.no === 'string' && obj.no.trim()) {
      return {
        no: obj.no.trim(),
        buyerName: typeof obj.buyerName === 'string' ? obj.buyerName.trim() : '',
        startedAt: obj.startedAt || new Date().toISOString(),
        qty: Number(obj.qty) || 0,
        moves: Number(obj.moves) || 0,
        amount: Number(obj.amount) || 0,
      };
    }
  } catch (e) { /* 解析失败按「未在出库中」处理 */ }
  return null;
}

function saveActiveOrder() {
  try {
    if (activeOrder) localStorage.setItem(ACTIVE_ORDER_KEY, JSON.stringify(activeOrder));
    else localStorage.removeItem(ACTIVE_ORDER_KEY);
  } catch (e) { /* 存不了不影响本次使用 */ }
}

/* 按订单号查云端已有出库进度（笔数 / 件数 / 金额，退货冲减后）。
   用于「开始出库」时识别老订单：查到就带出，查不到就是新订单。
   查询失败返回 null，不阻塞开始出库（按新订单处理） */
async function fetchExistingOrderProgress(no) {
  try {
    const { data, error } = await cloud.database.from('stock_moves')
      .select('move_type,quantity,unit_price,is_return,buyer_name')
      .eq('order_no', no)
      .limit(1000);
    if (error || !Array.isArray(data)) return null;
    let moves = 0, qty = 0, amount = 0, buyer = '';
    data.forEach((m) => {
      const q = Number(m.quantity) || 0;
      const pr = Number(m.unit_price) || 0;
      if (m.move_type === 'out') {
        moves += 1;
        qty += q;
        amount += q * pr;
        const b = String(m.buyer_name == null ? '' : m.buyer_name).trim();
        if (b) buyer = b;
      } else if (m.is_return) {
        // 与订单统计同口径：退货冲减数量与金额，不为负
        qty = Math.max(0, qty - q);
        amount = Math.max(0, amount - q * pr);
      }
    });
    return { moves, qty, amount, buyer };
  } catch (e) {
    return null;
  }
}

function renderOrderBar() {
  const bar = $('orderBar');
  if (!bar) return;
  const active = !!activeOrder;
  bar.classList.toggle('is-active', active);
  $('endOrderBtn').disabled = !active;

  const status = $('orderStatus');
  if (!active) {
    status.innerHTML = '未在出库中。填写订单 ID 后点「开始出库」，之后出库的商品都会记到这个订单号下；' +
      '<b>客户姓名选填</b>。出库必须关联订单号，不能开空单。';
    return;
  }
  const progress = activeOrder.moves > 0
    ? ' · 已出库 <b>' + activeOrder.moves + '</b> 笔 / <b>' + activeOrder.qty +
      '</b> 件 / <b>' + fmtUsd(activeOrder.amount) + '</b>'
    : ' · 还没出库任何商品';
  status.innerHTML = '当前正在为订单 <b>' + esc(activeOrder.no) + '</b>' +
    (activeOrder.buyerName ? '（客户 <b>' + esc(activeOrder.buyerName) + '</b>）' : '') + '出库' +
    '（' + esc(fmtTime(activeOrder.startedAt)) + ' 开始）' + progress;
}

async function startOrder() {
  const input = $('orderInput');
  const buyerInput = $('orderBuyerInput');
  const no = input.value.trim();
  let buyerName = buyerInput ? buyerInput.value.trim() : '';

  // 订单 ID 必填（出库必须关联订单号），客户姓名选填
  if (!no) {
    toast('请先填写订单 ID');
    input.focus();
    return;
  }
  if (activeOrder && activeOrder.no === no) {
    if ((activeOrder.buyerName || '') === buyerName) {
      toast('已经在为订单 ' + no + (buyerName ? '（' + buyerName + '）' : '') + '出库');
    } else {
      const prevName = activeOrder.buyerName || '未填';
      activeOrder.buyerName = buyerName;
      saveActiveOrder();
      renderOrderBar();
      toast('订单 ' + no + ' 的客户已从「' + prevName + '」改为「' + (buyerName || '未填') + '」');
    }
    input.value = '';
    if (buyerInput) buyerInput.value = '';
    return;
  }

  /* 先查云端：老订单带出已有出库进度与新订单区分开 */
  toast('正在查询订单 ' + no + ' …');
  const existing = await fetchExistingOrderProgress(no);
  let qty = 0, moves = 0, amount = 0;
  let extraNote = '';
  if (existing && existing.moves > 0) {
    moves = existing.moves;
    qty = existing.qty;
    amount = existing.amount;
    // 客户姓名：用户没填就带出订单里已有的
    if (!buyerName && existing.buyer) buyerName = existing.buyer;
    extraNote = '该订单已有 ' + moves + ' 笔 / ' + qty + ' 件 / ' + fmtUsd(amount) +
      ' 出库记录，已带出，继续出库即可';
  }

  const prev = activeOrder ? activeOrder.no : '';
  activeOrder = {
    no: no, buyerName: buyerName,
    startedAt: new Date().toISOString(), qty: qty, moves: moves, amount: amount,
  };
  saveActiveOrder();
  renderOrderBar();
  input.value = '';
  if (buyerInput) buyerInput.value = '';
  const who = buyerName ? '（' + buyerName + '）' : '';
  if (extraNote) {
    toast('订单 ' + no + who + '：' + extraNote);
  } else {
    toast(prev
      ? '已结束订单 ' + prev + ' 的出库，开始为 ' + no + who + '出库'
      : '新订单，开始为订单 ' + no + who + '出库');
  }
}

function endOrder() {
  if (!activeOrder) return;
  const { no, buyerName, qty, moves, amount } = activeOrder;
  activeOrder = null;
  saveActiveOrder();
  renderOrderBar();
  const who = buyerName ? '（' + buyerName + '）' : '';
  if (moves > 0) {
    toast('订单 ' + no + who + ' 出库结束：' + moves + ' 笔 / ' + qty + ' 件 / ' + fmtUsd(amount));
  } else {
    toast('订单 ' + no + who + ' 出库结束（未出库任何商品）');
  }
}

/* 出库弹窗里的订单信息：只读展示当前正在出库的订单与客户，订单号不可手改 */
function orderInfoHtml() {
  if (!activeOrder) {
    return '<div class="order-info is-empty">' +
        '<span class="oi-label">当前出库订单</span>' +
        '<div class="oi-row"><span class="oi-k">状态</span>' +
          '<span class="dash">未在出库中</span></div>' +
        '<span class="oi-note">出库必须关联订单号：请回库存页顶部填写订单 ID，再点「开始出库」。</span>' +
      '</div>' +
      '<label class="field"><span>备注</span><input id="bNote" type="text" placeholder="选填"></label>';
  }
  const name = activeOrder.buyerName || '';
  return '<div class="order-info">' +
      '<span class="oi-label">当前出库订单</span>' +
      '<div class="oi-row"><span class="oi-k">订单 ID</span>' +
        '<b class="oi-v">' + esc(activeOrder.no) + '</b></div>' +
      '<div class="oi-row"><span class="oi-k">客户姓名</span>' +
        (name ? '<b class="oi-v">' + esc(name) + '</b>' : '<span class="dash">未填写</span>') + '</div>' +
      '<span class="oi-note">本单的商品都会自动记到该订单名下；客户姓名可在订单管理页补填</span>' +
    '</div>' +
    '<label class="field"><span>备注</span><input id="bNote" type="text" placeholder="选填"></label>';
}

/* ================= 出入库 ================= */

function openMoveDialog(product, type) {
  const isOut = type === 'out';
  // 缺货商品不允许出库（列表里按钮已置灰，这里再兜一道）
  if (isOut && (Number(product.stock) || 0) <= 0) {
    toast('「' + product.name + '」已缺货，请先补货再出库');
    return;
  }
  // 出库必须关联订单号：没有正在进行的订单就不给开弹窗，避免出现无主的散单
  if (isOut && !activeOrder) {
    toast('出库必须关联订单号，请先填写订单 ID 并点「开始出库」');
    const input = $('orderInput');
    if (input) { input.focus(); input.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    return;
  }
  const price = isOut ? (Number(product.sale_price) || 0) : (Number(product.cost_price) || 0);
  const body =
    '<p class="hint">' + esc(product.name) + ' · 当前库存 <b>' + (Number(product.stock) || 0) + '</b></p>' +
    '<label class="field"><span>数量</span><input id="mQty" type="number" min="1" step="1" value="1"></label>' +
    '<label class="field"><span>' + (isOut ? '成交单价（美元 $）' : '进货单价（人民币 ¥）') +
      '</span><input id="mPrice" type="number" min="0" step="0.01" value="' + price + '"></label>' +
    (isOut ? orderInfoHtml() : '');
  openModal(isOut ? '出库销售' : '补货入库', body, () => submitMove(product, type));
}

async function submitMove(product, type) {
  const isOut = type === 'out';
  const qty = Math.round(toNum($('mQty').value));
  const price = toNum($('mPrice') ? $('mPrice').value : 0);

  if (qty <= 0) { $('modalError').textContent = '数量必须大于 0'; return true; }
  // 兜底：出库必须挂在正在进行的订单上（程序化调用也拦得住）
  if (isOut && !activeOrder) {
    $('modalError').textContent = '出库必须关联订单号：请先填写订单 ID 并点「开始出库」';
    return true;
  }

  const current = Number(product.stock) || 0;
  if (isOut && qty > current) {
    $('modalError').textContent = '库存不足，当前只有 ' + current;
    return true;
  }

  const move = {
    product_id: product.id,
    move_type: isOut ? 'out' : 'in',
    quantity: qty,
    unit_price: price,
  };

  if (isOut) {
    const note = ($('bNote') ? $('bNote').value : '').trim();
    // 订单号必带；客户姓名选填，填了才写
    move.order_no = activeOrder.no;
    if (activeOrder.buyerName) move.buyer_name = activeOrder.buyerName;
    if (note) move.buyer_note = note;
  }

  const ins = await cloud.database.from('stock_moves').insert(move);
  if (ins.error) { $('modalError').textContent = describeDbError(ins.error); return true; }

  const nowIso = new Date().toISOString();
  const nextStock = isOut ? current - qty : current + qty;
  // 同步维护最近一次入库 / 出库时间
  const patch = { stock: nextStock, updated_at: nowIso };
  if (isOut) patch.last_out_at = nowIso;
  else patch.last_in_at = nowIso;

  const upd = await cloud.database
    .from('products')
    .update(patch)
    .eq('id', product.id)
    .select();

  if (upd.error) {
    $('modalError').textContent = '流水已记录，但库存更新失败：' + describeDbError(upd.error);
    return true;
  }
  if (!Array.isArray(upd.data) || upd.data.length === 0) {
    $('modalError').textContent = '库存更新未生效，请刷新后重试';
    return true;
  }

  // 这笔出库若属于当前正在进行的订单，同步累加会话进度
  if (isOut && move.order_no && activeOrder && activeOrder.no === move.order_no) {
    activeOrder.qty += qty;
    activeOrder.moves += 1;
    activeOrder.amount += qty * price;
    saveActiveOrder();
    renderOrderBar();
  }

  toast(isOut ? '出库成功 · 订单 ' + move.order_no : '补货成功');
  await loadInventory();
  return false;
}

/* ================= 编辑商品 ================= */

function openEditDialog(p) {
  const body =
    '<label class="field"><span>产品编码</span><input id="eCode" type="text" value="' + esc(p.code) + '"></label>' +
    '<label class="field"><span>产品名称</span><input id="eName" type="text" value="' + esc(p.name) + '"></label>' +
    '<label class="field"><span>品牌</span><input id="eBrand" type="text" list="brandOptions" value="' + esc(p.brand) + '"></label>' +
    '<label class="field"><span>产地</span><input id="eOrigin" type="text" value="' + esc(p.origin) + '"></label>' +
    '<label class="field"><span>材质</span><input id="eMaterial" type="text" value="' + esc(p.material) + '"></label>' +
    '<label class="field"><span>规格</span><input id="eSpec" type="text" value="' + esc(p.spec) + '"></label>' +
    '<label class="field"><span>执行标准</span><input id="eStandard" type="text" value="' + esc(p.standard) + '"></label>' +
    '<label class="field"><span>进货渠道</span><select id="eChannel">' + channelOptionsHtml(p.purchase_channel) + '</select></label>' +
    '<label class="field"><span>进货商名称</span><input id="eSupplier" type="text" list="supplierOptions" placeholder="选填，可从列表选也可直接输入" value="' + esc(p.supplier_name) + '"></label>' +
    '<label class="field"><span>进价（人民币 ¥）</span><input id="eCost" type="number" min="0" step="0.01" placeholder="选填" value="' + (p.cost_price == null ? '' : Number(p.cost_price)) + '"></label>' +
    '<label class="field"><span>售价（美元 $）</span><input id="eSale" type="number" min="0" step="0.01" placeholder="选填" value="' + (p.sale_price == null ? '' : Number(p.sale_price)) + '"></label>' +
    '<label class="field"><span>备注</span><input id="eNote" type="text" value="' + esc(p.note) + '"></label>' +
    '<p class="hint">库存不在这里直接改，请用「补货 / 出库销售」以保证流水完整</p>' +
    '<div class="actions" style="margin-top:14px">' +
      '<button type="button" class="danger small" data-del-product="' + esc(p.id) + '">删除商品</button>' +
    '</div>';

  openModal('编辑商品', body, async () => {
    const name = $('eName').value.trim();
    if (!name) { $('modalError').textContent = '产品名称不能为空'; return true; }

    const upd = await cloud.database.from('products').update({
      code: $('eCode').value.trim(),
      name,
      brand: $('eBrand').value.trim() || null,
      origin: $('eOrigin').value.trim() || null,
      material: $('eMaterial').value.trim() || null,
      spec: $('eSpec').value.trim() || null,
      standard: $('eStandard').value.trim() || null,
      purchase_channel: $('eChannel').value.trim() || null,
      supplier_name: $('eSupplier').value.trim() || null,
      cost_price: $('eCost').value.trim() === '' ? null : toNum($('eCost').value),
      sale_price: $('eSale').value.trim() === '' ? null : toNum($('eSale').value),
      note: $('eNote').value.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('id', p.id).select();

    if (upd.error) { $('modalError').textContent = describeDbError(upd.error); return true; }
    if (!Array.isArray(upd.data) || upd.data.length === 0) {
      $('modalError').textContent = '未修改任何数据，请刷新后重试';
      return true;
    }
    toast('已保存');
    await loadInventory();
    return false;
  });

  /* 删除入口：编辑弹窗里的红色按钮，点击后弹独立确认窗，不经「确定」回调 */
  const delBtn = $('modalBody').querySelector('[data-del-product]');
  if (delBtn) delBtn.addEventListener('click', () => confirmDeleteProduct(p));
}

/* ---------- 归档 / 恢复 ----------
   归档 = 停售不抹历史：商品从在售列表隐藏，不能出库补货，
   但历史流水、订单、报表原样保留，随时可一键恢复 */

function openArchiveDialog(p) {
  openModal('归档商品',
    '<p class="hint">「' + esc(p.name) + '」会从库存列表隐藏，不能再出库 / 补货；' +
      '历史流水、订单与报表<b>全部保留</b>，之后在「已归档」里可随时恢复上架。</p>',
    async () => {
      const { error } = await cloud.database.from('products')
        .update({ archived: true, updated_at: new Date().toISOString() })
        .eq('id', p.id);
      if (error) { $('modalError').textContent = describeDbError(error); return true; }
      toast('已归档「' + p.name + '」');
      await loadInventory();
      return false;
    });
}

function openRestoreDialog(p) {
  openModal('恢复上架',
    '<p class="hint">「' + esc(p.name) + '」会重新出现在在售列表，可以正常出库 / 补货。当前库存 ' +
      (Number(p.stock) || 0) + ' 件。</p>',
    async () => {
      const { error } = await cloud.database.from('products')
        .update({ archived: false, updated_at: new Date().toISOString() })
        .eq('id', p.id);
      if (error) { $('modalError').textContent = describeDbError(error); return true; }
      toast('「' + p.name + '」已恢复上架');
      await loadInventory();
      return false;
    });
}

/* ---------- 删除（商品 / 订单） ---------- */

/* 撤销一条流水对库存的影响：
   入库 → 当初加了 qty，删掉要减回；
   普通出库 → 当初减了 qty，删掉要加回；
   退货出库（is_return）→ 当初加了 qty，删掉要减回 */
function stockDeltaForMove(m) {
  const qty = Number(m.quantity) || 0;
  if (m.move_type === 'in') return -qty;
  if (m.is_return) return -qty;
  return qty;
}

function confirmDeleteProduct(p) {
  openModal('删除商品',
    '<p class="hint">「' + esc(p.name || p.code) + '」及其全部出入库流水会一并删除，'
      + '报表统计同步减少，删除后无法恢复。确定删除？</p>',
    async () => {
      const del = await cloud.database.from('products').delete().eq('id', p.id);
      if (del.error) { $('modalError').textContent = describeDbError(del.error); return true; }
      if (p.image_path) {
        try { await cloud.storage.remove([p.image_path]); } catch (e) { /* 存储清理失败不影响 */ }
      }
      closeModal();
      toast('商品已删除');
      await loadInventory();
      return false;
    }, '删除');
}

/* 删除整个订单：先按流水回补各商品库存，再删流水 + 其他成本 + 发货记录。
   顺序很重要：流水删掉之后就查不到该回补多少了 */
async function deleteOrderFlow(orderNo) {
  const movesRes = await cloud.database.from('stock_moves')
    .select('id, product_id, quantity, move_type, is_return')
    .eq('order_no', orderNo);
  if (movesRes.error) { toast('读取订单失败：' + describeDbError(movesRes.error)); return; }
  const moves = Array.isArray(movesRes.data) ? movesRes.data : [];
  if (moves.length === 0) { toast('该订单没有流水，可能已被删除'); return; }

  const deltaByProduct = new Map();
  moves.forEach((m) => {
    const pid = m.product_id;
    if (!pid) return;
    deltaByProduct.set(pid, (deltaByProduct.get(pid) || 0) + stockDeltaForMove(m));
  });

  let stockFailed = 0;
  for (const [pid, delta] of deltaByProduct.entries()) {
    if (!delta) continue;
    try {
      const cur = await cloud.database.from('products').select('id, stock').eq('id', pid).maybeSingle();
      if (cur.error || !cur.data) { stockFailed += 1; continue; }
      const next = Math.max(0, (Number(cur.data.stock) || 0) + delta);
      const upd = await cloud.database.from('products').update({
        stock: next, updated_at: new Date().toISOString(),
      }).eq('id', pid);
      if (upd.error) stockFailed += 1;
    } catch (e) {
      stockFailed += 1;
    }
  }

  const delMoves = await cloud.database.from('stock_moves').delete().eq('order_no', orderNo);
  if (delMoves.error) { toast('删除失败：' + describeDbError(delMoves.error)); return; }
  const costDel = await cloud.database.from('order_costs').delete().eq('order_no', orderNo);
  const shipDel = await cloud.database.from('order_shipments').delete().eq('order_no', orderNo);
  const auxFailed = (costDel.error ? 1 : 0) + (shipDel.error ? 1 : 0);

  toast('订单已删除' + (stockFailed ? '，' + stockFailed + ' 个商品库存回补失败' : '')
    + (auxFailed ? '，' + auxFailed + ' 项附加记录清理失败' : ''));
  await Promise.all([loadInventory(), loadOrders(), loadMoves()]);
  selectedOrderNo = null;
  renderOrders();
}

/* ================= 流水 ================= */

let movesCache = [];
/* 按订单查看流水：不再提供手工输入框，只由「点流水里的订单号」或
   「订单管理页 → 在流水页查看」写入；toolbar 上以可取消的标签呈现 */
let moveOrderFilter = '';
/* 只看入库 / 只看出库（全部时为 all），与其它筛选叠加 */
let moveKindFilter = 'all';

async function loadMoves() {
  const box = $('movesList');
  box.innerHTML = '';
  box.appendChild(emptyEl('加载中…'));
  const costsPromise = loadOrderCosts();   // 与流水并行加载，不拖慢列表
  try {
    const { data, error } = await cloud.database
      .from('stock_moves')
      .select('*, product:products(id, name, code)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      box.innerHTML = '';
      box.appendChild(emptyEl(describeDbError(error)));
      return;
    }
    movesCache = Array.isArray(data) ? data : [];
    await costsPromise;
    renderMoves();
  } catch (err) {
    box.innerHTML = '';
    box.appendChild(emptyEl('加载失败，请重试'));
  }
}

function renderMoves() {
  const box = $('movesList');
  const buyerKw = $('moveBuyerInput').value.trim().toLowerCase();
  const productKw = $('moveProductInput').value.trim().toLowerCase();
  const orderKw = moveOrderFilter.toLowerCase();
  const kind = moveKindFilter;   // all | in | out
  const filtered = !!(buyerKw || productKw || orderKw || kind !== 'all');

  const rows = movesCache.filter((m) => {
    const p = m.product || {};
    if (kind === 'in' && m.move_type !== 'in') return false;
    if (kind === 'out' && m.move_type !== 'out') return false;
    if (buyerKw) {
      // 购买者筛选只认姓名，电话 / 地址 / 备注不参与匹配
      if (String(m.buyer_name == null ? '' : m.buyer_name).toLowerCase().indexOf(buyerKw) < 0) return false;
    }
    if (productKw) {
      const productText = [p.name, p.code]
        .map((v) => String(v == null ? '' : v)).join(' ').toLowerCase();
      if (productText.indexOf(productKw) < 0) return false;
    }
    if (orderKw) {
      if (String(m.order_no == null ? '' : m.order_no).toLowerCase().indexOf(orderKw) < 0) return false;
    }
    return true;
  });

  box.innerHTML = '';
  if (rows.length === 0) {
    box.appendChild(emptyEl(filtered ? '没有匹配的流水记录' : '还没有出入库记录'));
  } else {
    const frag = document.createDocumentFragment();
    rows.forEach((m) => frag.appendChild(moveItem(m)));
    box.appendChild(frag);
  }
  updateMovesCount(rows.length, movesCache.length, filtered);
  // 只看某个订单时，同步结算这一单（走服务端查询，不受上面 200 条窗口限制）
  scheduleOrderSummary(moveOrderFilter);
}

/* 「全部 / 只看入库 / 只看出库」——与购买者、商品、订单筛选叠加 */
function renderMoveKindSeg() {
  const seg = $('moveKindSeg');
  if (!seg) return;
  seg.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.kind === moveKindFilter);
  });
}

function setMoveKind(kind) {
  moveKindFilter = kind === 'in' || kind === 'out' ? kind : 'all';
  renderMoveKindSeg();
  renderMoves();
}

function updateMovesCount(shown, total, filtered) {
  const el = $('movesCount');
  if (!el) return;
  if (total === 0) { el.textContent = ''; return; }
  el.textContent = filtered
    ? '筛选出 ' + shown + ' 条 / 共 ' + total + ' 条'
    : '共 ' + total + ' 条记录';
}

function clearMoveFilter() {
  $('moveBuyerInput').value = '';
  $('moveProductInput').value = '';
  moveOrderFilter = '';
  moveKindFilter = 'all';
  renderOrderFilterTag();
  renderMoveKindSeg();
  renderMoves();
}

/* 设置 / 清除「只看某个订单」的筛选（订单号标签、订单管理页跳转都会走这里） */
function setMoveOrderFilter(no) {
  moveOrderFilter = String(no == null ? '' : no).trim();
  renderOrderFilterTag();
  renderMoves();
}

function renderOrderFilterTag() {
  const el = $('moveOrderFilter');
  if (!el) return;
  if (!moveOrderFilter) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.classList.remove('hidden');
  el.textContent = '只看订单 ' + moveOrderFilter + ' ×';
}

function moveItem(m) {
  const isOut = m.move_type === 'out';
  const isReturn = !!m.is_return;
  const p = m.product || {};
  const buyer = [m.buyer_name, m.buyer_phone, m.buyer_addr].filter(Boolean).join(' · ');
  const buyerLine = buyer
    ? esc(buyer)
    : '<span class="dash">未填写</span>';

  // 订单号做成可点的标签，一点即筛出该订单的全部流水
  const orderCell = m.order_no
    ? '<button type="button" class="order-chip" data-order="' + esc(m.order_no) +
      '" title="只看该订单的流水">' + esc(m.order_no) + '</button>'
    : '<span class="dash">' + (isOut ? '未关联订单' : '—') + '</span>';

  const el = document.createElement('div');
  el.className = 'item' + (isReturn ? ' is-return' : '');
  el.innerHTML =
    '<div class="item-main">' +
      '<p class="item-title">' + esc(p.name || '（商品已删除）') +
        (isReturn
          ? '<span class="badge ret">退货入库</span>'
          : '<span class="badge ' + (isOut ? 'sale' : 'in') + '">' + (isOut ? '出库' : '入库') + '</span>') + '</p>' +
      '<p class="item-meta">数量 <b>' + (isOut ? '-' : '+') + m.quantity + '</b> · 单价 <b>' +
        (isOut ? fmtUsd(m.unit_price) : fmtMoney(m.unit_price)) + '</b> · ' + esc(fmtTime(m.created_at)) + '</p>' +
      (isOut || m.order_no ? '<p class="item-meta">订单：' + orderCell + '</p>' : '') +
      '<p class="item-meta">购买者：' + buyerLine +
        (m.buyer_note ? ' · 备注 ' + esc(m.buyer_note) : '') + '</p>' +
    '</div>';
  return el;
}

/* ================= 按订单结算 =================
   按订单筛选流水时，除了列出明细，还在上方给出这一单的账：

     订单金额 = Σ 出库数量 × 成交单价
     商品成本 = Σ 出库数量 × 商品当前进价
     其他成本 = 用户为本单录入的费用（运费 / 佣金 / 包装……）
     净利润   = 订单金额 - 商品成本 - 其他成本

   两个关键点：
   1) 结算用的流水走服务端按 order_no 查询，不依赖列表「最近 200 条」
      的窗口——否则订单流水被截断，金额会算少。
   2) 查询用 ilike 做片段匹配，与列表筛选口径保持一致。
   ============================================== */

let orderCosts = new Map();      // order_no -> { other_cost, cost_note }
let orderStatsRows = [];         // 本次命中的出库流水（服务端返回）
let orderSummaryKw = '';
let orderSummaryTimer = null;
let orderSummarySeq = 0;         // 递增序号，用于丢弃过期响应

const ORDER_MOVES_LIMIT = 1000;  // 单次最多取多少个订单流水
const ORDER_CARDS_MAX = 20;      // 一次最多渲染多少张订单结算卡

async function loadOrderCosts() {
  try {
    const { data, error } = await cloud.database.from('order_costs').select('*').limit(1000);
    if (error) return;
    const next = new Map();
    (Array.isArray(data) ? data : []).forEach((r) => {
      next.set(String(r.order_no), {
        other_cost: Number(r.other_cost) || 0,
        cost_note: r.cost_note || '',
      });
    });
    orderCosts = next;
  } catch (e) {
    /* 读取失败时按「无其他成本」处理，不影响主流程 */
  }
}

function orderCostOf(orderNo) {
  return orderCosts.get(String(orderNo)) || { other_cost: 0, cost_note: '' };
}

/* 把流水按订单号聚合成结算数据（纯函数，便于单独验证）
   keyword 为空表示统计全部；只统计出库，入库记录单独计数 */
function buildOrderStats(rows, keyword) {
  const kw = String(keyword == null ? '' : keyword).toLowerCase();
  const rate = rateOf();
  const map = new Map();
  let skippedIn = 0;

  (Array.isArray(rows) ? rows : []).forEach((m) => {
    const no = String(m.order_no == null ? '' : m.order_no);
    if (!no) return;
    if (kw && no.toLowerCase().indexOf(kw) < 0) return;

    const isOut = m.move_type === 'out';
    const isReturn = !!m.is_return;
    // 只认两类记录：出库，以及为本单退回库存的入库；普通补货入库不计入订单
    if (!isOut && !isReturn) { skippedIn += 1; return; }

    let r = map.get(no);
    if (!r) {
      r = {
        order_no: no, moves: 0, qty: 0, salesUsd: 0, cost: 0,
        returnMoves: 0, returnQty: 0, returnSalesUsd: 0, returnCost: 0,
        orphanQty: 0, zeroCostMoves: 0, zeroPriceMoves: 0,
        buyer: '', lastBuyer: '',
        firstAt: null, lastAt: null,
        products: new Map(),
      };
      map.set(no, r);
    }

    const qty = Number(m.quantity) || 0;
    const price = Number(m.unit_price) || 0;
    const p = m.product || null;
    const unitCost = p ? (Number(p.cost_price) || 0) : 0;
    const pname = p ? p.name : '（商品已删除）';

    // 退回库存：金额与成本按原成交单价、商品当前进价反向冲减
    if (isReturn) {
      r.returnMoves += 1;
      r.returnQty += qty;
      r.returnSalesUsd += qty * price;
      r.returnCost += qty * unitCost;
      r.products.set(pname, (r.products.get(pname) || 0) - qty);
      return;
    }

    // 客户姓名：整个订单带同一个客户，取第一条非空值即可（lastBuyer 记录最新一版）
    const buyerName = String(m.buyer_name == null ? '' : m.buyer_name).trim();
    if (buyerName) {
      if (!r.buyer) r.buyer = buyerName;
      r.lastBuyer = buyerName;
    }
    if (!p) r.orphanQty += qty;
    else if (!(unitCost > 0)) r.zeroCostMoves += 1;
    // 出库时没填单价 → 订单金额会偏低，单独提示
    if (!(price > 0)) r.zeroPriceMoves += 1;

    r.moves += 1;
    r.qty += qty;
    r.salesUsd += qty * price;
    r.cost += qty * unitCost;

    const t = new Date(m.created_at).getTime();
    if (Number.isFinite(t)) {
      if (r.firstAt == null || t < r.firstAt) r.firstAt = t;
      if (r.lastAt == null || t > r.lastAt) r.lastAt = t;
    }

    r.products.set(pname, (r.products.get(pname) || 0) + qty);
  });

  const list = Array.from(map.values()).map((r) => {
    const extra = orderCostOf(r.order_no);
    const other = Number(extra.other_cost) || 0;
    // 净额 = 出库 − 退货；max(0) 兜住退货多于出库的历史脏数据
    const qty = Math.max(0, r.qty - r.returnQty);
    const salesUsd = Math.max(0, r.salesUsd - r.returnSalesUsd);
    const cost = Math.max(0, r.cost - r.returnCost);
    // 售价是美元，先折成人民币再和人民币成本相减，否则利润没有意义
    const sales = salesUsd * rate;
    const net = sales - cost - other;
    return Object.assign(r, {
      qty, salesUsd, cost, sales, rate,
      otherCost: other,
      costNote: extra.cost_note || '',
      net,
      margin: sales > 0 ? net / sales : null,
      products: Array.from(r.products.entries()).filter((e) => e[1] > 0),
    });
  });

  // 金额大的排前面，一眼能看到主单
  list.sort((a, b) => b.sales - a.sales);

  const total = list.reduce((t, r) => ({
    orders: t.orders + 1,
    moves: t.moves + r.moves,
    qty: t.qty + r.qty,
    sales: t.sales + r.sales,
    salesUsd: t.salesUsd + r.salesUsd,
    cost: t.cost + r.cost,
    otherCost: t.otherCost + r.otherCost,
    net: t.net + r.net,
    returnQty: t.returnQty + r.returnQty,
  }), { orders: 0, moves: 0, qty: 0, sales: 0, salesUsd: 0, cost: 0, otherCost: 0, net: 0, returnQty: 0 });

  return { list, total, skippedIn, rate };
}

/* 订单内的时间范围：10-14 15:35 ~ 15:40 */
function fmtRange(from, to) {
  if (!from) return '';
  const p = (n) => String(n).padStart(2, '0');
  const a = new Date(from);
  if (Number.isNaN(a.getTime())) return '';
  const head = p(a.getMonth() + 1) + '-' + p(a.getDate()) + ' ' + p(a.getHours()) + ':' + p(a.getMinutes());
  if (!to || to === from) return head;
  const b = new Date(to);
  if (Number.isNaN(b.getTime())) return head;
  const sameDay = a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const tail = sameDay
    ? p(b.getHours()) + ':' + p(b.getMinutes())
    : p(b.getMonth() + 1) + '-' + p(b.getDate()) + ' ' + p(b.getHours()) + ':' + p(b.getMinutes());
  return head + ' ~ ' + tail;
}

function orderSumCardHtml(r) {
  const netCls = r.net > 0 ? ' is-net' : (r.net < 0 ? ' is-loss' : '');
  const marginNote = r.margin == null ? '' : '毛利率 ' + (r.margin * 100).toFixed(1) + '%';

  const notes = [];
  if (r.costNote) notes.push('其他成本说明：' + r.costNote);
  if (r.returnQty > 0) notes.push('已退回库存 ' + r.returnQty + ' 件（金额与成本已按退货冲减）');
  if (r.zeroPriceMoves > 0) notes.push(r.zeroPriceMoves + ' 笔出库未填单价，订单金额偏低');
  if (r.orphanQty > 0) notes.push(r.orphanQty + ' 件商品已删除，成本未计入');
  if (r.zeroCostMoves > 0) notes.push(r.zeroCostMoves + ' 笔商品未填进价，成本可能偏低');

  const shown = r.products.slice(0, 3).map(([n, q]) => esc(n) + ' ×' + q).join('、');
  const more = r.products.length > 3 ? ' 等 ' + r.products.length + ' 款' : '';

  return '<div class="order-sum-card">' +
    '<div class="order-sum-head">' +
      '<span class="order-sum-no">' + esc(r.order_no) + '</span>' +
      '<span class="order-sum-meta">' + r.moves + ' 笔 · ' + r.qty + ' 件 · ' +
        esc(fmtRange(r.firstAt, r.lastAt)) + '</span>' +
      '<button type="button" class="ghost small" data-cost="' + esc(r.order_no) + '">' +
        (r.otherCost > 0 ? '修改其他成本' : '录入其他成本') + '</button>' +
    '</div>' +
    '<div class="order-sum-grid">' +
      '<div><p class="os-label">订单金额</p><p class="os-value">' + fmtMoney(r.sales) + '</p>' +
        '<p class="os-formula">' + fmtUsd(r.salesUsd) + ' × ' + fmtRate() + '</p></div>' +
      '<div><p class="os-label">商品成本</p><p class="os-value">' + fmtMoney(r.cost) + '</p></div>' +
      '<div><p class="os-label">其他成本</p><p class="os-value">' + fmtMoney(r.otherCost) + '</p></div>' +
      '<div><p class="os-label">净利润</p><p class="os-value' + netCls + '">' + fmtMoney(r.net) + '</p>' +
        (marginNote ? '<p class="os-note">' + marginNote + '</p>' : '') + '</div>' +
    '</div>' +
    '<p class="os-note">' + (shown || '') + more +
      (notes.length ? '　·　' + notes.map(esc).join('；') : '') + '</p>' +
  '</div>';
}

function renderOrderSummary() {
  const box = $('orderSummary');
  if (!box) return;
  if (!orderSummaryKw) {
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');

  const { list, total, skippedIn } = buildOrderStats(orderStatsRows, orderSummaryKw);
  if (list.length === 0) {
    box.innerHTML = '<p class="empty">该订单还没有出库记录，无法结算（入库不计入订单金额）</p>';
    return;
  }

  const lead = [];
  lead.push(list.length === 1 ? '订单结算' : '命中 ' + total.orders + ' 个订单');
  lead.push('金额 ' + fmtMoney(total.sales) + '（' + fmtUsd(total.salesUsd) + ' × ' + fmtRate() + '）' +
    ' · 成本 ' + fmtMoney(total.cost + total.otherCost) +
    ' · 净利润 ' + fmtMoney(total.net));
  if (list.length > ORDER_CARDS_MAX) lead.push('仅展示金额前 ' + ORDER_CARDS_MAX + ' 个');
  if (skippedIn > 0) lead.push('另有 ' + skippedIn + ' 笔入库未计入');

  box.innerHTML =
    '<p class="order-sum-lead">' + esc(lead.join(' · ')) + '</p>' +
    list.slice(0, ORDER_CARDS_MAX).map(orderSumCardHtml).join('');
}

function scheduleOrderSummary(kw) {
  const box = $('orderSummary');
  if (!box) return;
  const changed = kw !== orderSummaryKw;
  orderSummaryKw = kw;
  clearTimeout(orderSummaryTimer);

  if (!kw) {
    orderSummarySeq += 1;        // 作废在途请求
    orderStatsRows = [];
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }

  box.classList.remove('hidden');
  if (!changed && orderStatsRows.length > 0) { renderOrderSummary(); return; }

  box.innerHTML = '<p class="empty">正在结算订单…</p>';
  orderSummaryTimer = setTimeout(() => { loadOrderSummary(kw); }, 350);
}

async function loadOrderSummary(kw) {
  const box = $('orderSummary');
  if (!box) return;
  const seq = ++orderSummarySeq;
  if (orderSummaryKw === kw) {
    box.classList.remove('hidden');
    box.innerHTML = '<p class="empty">正在结算订单…</p>';
  }

  try {
    const { data, error } = await cloud.database
      .from('stock_moves')
      .select('*, product:products(id, name, code, cost_price)')
      .ilike('order_no', '%' + kw + '%')
      .order('created_at', { ascending: true })
      .limit(ORDER_MOVES_LIMIT);

    if (seq !== orderSummarySeq) return;   // 已有更新的查询，丢弃本次
    if (error) {
      box.innerHTML = '<p class="empty">订单结算查询失败：' + esc(describeDbError(error)) + '</p>';
      return;
    }
    orderStatsRows = Array.isArray(data) ? data : [];
    renderOrderSummary();
  } catch (err) {
    if (seq !== orderSummarySeq) return;
    box.innerHTML = '<p class="empty">订单结算查询失败，请重试</p>';
  }
}

/* 录入本单的其它成本（运费 / 佣金 / 包装……），录完立即重算净利润 */
function openOrderCostDialog(orderNo) {
  const cur = orderCostOf(orderNo);
  const body =
    '<p class="hint">这里填除商品进价之外的整单费用，比如运费、平台佣金、包装费。保存后自动从利润里扣掉。</p>' +
    '<label class="field"><span>其他成本（元）</span><input id="ocCost" type="number" min="0" step="0.01" value="' +
      (cur.other_cost || 0) + '"></label>' +
    '<label class="field"><span>费用说明（选填）</span><input id="ocNote" type="text" placeholder="例如：运费 5 + 平台佣金 2" value="' +
      esc(cur.cost_note) + '"></label>';

  openModal('订单其他成本 · ' + orderNo, body, async () => {
    const raw = $('ocCost').value.trim();
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || value < 0) {
      $('modalError').textContent = '请填写不小于 0 的金额';
      return true;
    }
    const note = $('ocNote').value.trim();
    const payload = {
      other_cost: value,
      cost_note: note || null,
      updated_at: new Date().toISOString(),
    };

    const upd = await cloud.database.from('order_costs')
      .update(payload).eq('order_no', orderNo).select();
    if (upd.error) { $('modalError').textContent = describeDbError(upd.error); return true; }

    if (!Array.isArray(upd.data) || upd.data.length === 0) {
      const ins = await cloud.database.from('order_costs')
        .insert(Object.assign({ order_no: orderNo }, payload)).select();
      if (ins.error) { $('modalError').textContent = describeDbError(ins.error); return true; }
      if (!Array.isArray(ins.data) || ins.data.length === 0) {
        $('modalError').textContent = '保存失败，请重试';
        return true;
      }
    }

    orderCosts.set(String(orderNo), { other_cost: value, cost_note: note });
    toast('已保存其他成本');
    renderOrderSummary();
    renderOrders();          // 订单管理页同步刷新（不在该页时是空操作）
    return false;
  });
}

/* ================= 订单管理 =================
   列表 = 有订单号的流水按订单号聚合（复用 buildOrderStats，口径与流水页结算卡一致）
   详情 = 该订单的每笔出库明细 + 成本利润构成（可录入其他成本）
   ============================================================ */

const ORDERS_LIMIT = 2000;      // 单次最多拉取多少条流水用于聚合

let ordersRows = [];            // 原始流水（含商品关联）
let ordersAgg = [];             // 当前展示的聚合订单（已筛选 / 排序）
let ordersSort = 'time';        // time | sales | net
let selectedOrderNo = null;     // 当前选中的订单号
let shipments = new Map();      // order_no -> 发货记录（一单一条）

/* 发货记录：一个订单一条，缺省为空 */
async function loadShipments() {
  try {
    const { data, error } = await cloud.database
      .from('order_shipments')
      .select('*')
      .limit(ORDERS_LIMIT);
    if (error) return;
    const map = new Map();
    (Array.isArray(data) ? data : []).forEach((s) => map.set(String(s.order_no), s));
    shipments = map;
  } catch (e) { /* 发货记录读不到不影响订单列表 */ }
}

async function loadOrders() {
  const box = $('ordersList');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(emptyEl('加载中…'));
  try {
    const costsPromise = loadOrderCosts();   // 其他成本与流水并行取
    const shipPromise = loadShipments();
    const { data, error } = await cloud.database
      .from('stock_moves')
      .select('*, product:products(id, name, code, cost_price)')
      .order('created_at', { ascending: true })
      .limit(ORDERS_LIMIT);
    if (error) {
      box.innerHTML = '';
      box.appendChild(emptyEl(describeDbError(error)));
      $('orderDetail').innerHTML = '<p class="empty">订单数据加载失败</p>';
      return;
    }
    await costsPromise;
    await shipPromise;
    ordersRows = (Array.isArray(data) ? data : [])
      .filter((m) => String(m.order_no == null ? '' : m.order_no).trim() !== '');
    renderOrders();
  } catch (err) {
    box.innerHTML = '';
    box.appendChild(emptyEl('加载失败，请重试'));
  }
}

/* 聚合 + 关键词筛选 + 排序 */
function computeOrders() {
  const { list, total, skippedIn } = buildOrderStats(ordersRows, '');
  const input = $('orderSearchInput');
  const kw = (input ? input.value : '').trim().toLowerCase();

  let rows = list;
  if (kw) {
    rows = rows.filter((r) => {
      const hay = [r.order_no, r.buyer, r.lastBuyer]
        .concat(r.products.map(([n]) => n)).join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }

  const sorters = {
    time: (a, b) => (b.lastAt || 0) - (a.lastAt || 0),
    sales: (a, b) => b.sales - a.sales,
    net: (a, b) => b.net - a.net,
  };
  rows = rows.slice().sort(sorters[ordersSort] || sorters.time);
  return { rows, total, skippedIn };
}

function renderOrders() {
  const box = $('ordersList');
  if (!box) return;
  const filtered = !!($('orderSearchInput') && $('orderSearchInput').value.trim());
  const { rows, total } = computeOrders();
  ordersAgg = rows;

  box.innerHTML = '';
  if (rows.length === 0) {
    box.appendChild(emptyEl(ordersRows.length === 0
      ? '还没有带订单号的出库记录：在库存页填订单 ID 点「开始出库」后，这里就会出现'
      : '没有匹配的订单'));
  } else {
    const frag = document.createDocumentFragment();
    rows.forEach((r) => frag.appendChild(orderItem(r)));
    box.appendChild(frag);
  }

  updateOrdersCount(rows, total, filtered);
  renderOrderDetail();
}

function updateOrdersCount(rows, total, filtered) {
  const el = $('ordersCount');
  if (!el) return;
  if (total.orders === 0) { el.textContent = ''; return; }
  const shown = rows.reduce((t, r) => ({
    orders: t.orders + 1,
    moves: t.moves + r.moves,
    qty: t.qty + r.qty,
    sales: t.sales + r.sales,
    cost: t.cost + r.cost,
    otherCost: t.otherCost + r.otherCost,
    net: t.net + r.net,
  }), { orders: 0, moves: 0, qty: 0, sales: 0, cost: 0, otherCost: 0, net: 0 });

  const tail = '金额 ' + fmtMoney(shown.sales) +
    ' · 商品成本 ' + fmtMoney(shown.cost) +
    ' · 其他成本 ' + fmtMoney(shown.otherCost) +
    ' · 净利润 ' + fmtMoney(shown.net);
  el.textContent = filtered
    ? '筛选出 ' + shown.orders + ' 个订单 / 共 ' + total.orders + ' 个 · ' + tail
    : '共 ' + shown.orders + ' 个订单 · ' + shown.moves + ' 笔出库 · ' + shown.qty + ' 件 · ' + tail;
}

function orderItem(r) {
  const netCls = r.net > 0 ? ' is-net' : (r.net < 0 ? ' is-loss' : '');
  const flag = r.net > 0
    ? '<span class="badge net">盈利</span>'
    : (r.net < 0 ? '<span class="badge loss">亏损</span>' : '');

  const el = document.createElement('div');
  el.className = 'item order-row' + (String(r.order_no) === String(selectedOrderNo) ? ' is-selected' : '');
  el.dataset.orderRow = r.order_no;
  el.innerHTML =
    '<div class="item-main">' +
      '<p class="item-title">' + esc(r.order_no) + flag + '</p>' +
      '<p class="item-meta">客户 <b>' +
        (r.buyer ? esc(r.buyer) : '<span class="dash">未填写</span>') + '</b> · ' +
        r.moves + ' 笔 · ' + r.qty + ' 件</p>' +
      '<p class="item-meta">金额 <b>' + fmtMoney(r.sales) + '</b> · 成本 <b>' +
        fmtMoney(r.cost + r.otherCost) + '</b> · 净利润 <b class="' + netCls.trim() + '">' +
        fmtMoney(r.net) + '</b></p>' +
      '<p class="item-meta">' + esc(fmtRange(r.firstAt, r.lastAt)) + '</p>' +
    '</div>' +
    '<div class="item-actions"><span class="detail-arrow">详情 ›</span></div>';
  return el;
}

function renderOrderDetail() {
  const box = $('orderDetail');
  if (!box) return;
  if (!selectedOrderNo) {
    box.innerHTML = '<p class="empty">从左侧选择一个订单，即可查看明细与成本利润</p>';
    return;
  }
  const r = ordersAgg.filter((x) => String(x.order_no) === String(selectedOrderNo))[0];
  if (!r) {
    box.innerHTML = '<p class="empty">当前筛选下没有这个订单</p>';
    return;
  }
  box.innerHTML = orderDetailHtml(r);
}

/* 一个订单按商品汇总：出库数量、已退回数量、可退回数量、最后一笔出库单价 */
function orderProductLines(orderNo) {
  const rows = ordersRows.filter((m) => String(m.order_no) === String(orderNo));
  const map = new Map();
  rows.forEach((m) => {
    const pid = String(m.product_id);
    let r = map.get(pid);
    if (!r) {
      const p = m.product || {};
      r = {
        product_id: m.product_id,
        name: p.name || '（商品已删除）',
        code: p.code || '',
        outQty: 0, returnQty: 0, lastPrice: 0, lastOutAt: null,
      };
      map.set(pid, r);
    }
    const q = Number(m.quantity) || 0;
    if (m.move_type === 'out') {
      r.outQty += q;
      // 退货按「最后一笔出库的成交单价」冲减，和当时卖价对得上
      const t = new Date(m.created_at).getTime();
      if (r.lastOutAt == null || t >= r.lastOutAt) {
        r.lastOutAt = t;
        r.lastPrice = Number(m.unit_price) || 0;
      }
    } else if (m.is_return) {
      r.returnQty += q;
    }
  });
  return Array.from(map.values()).map((r) => Object.assign(r, {
    netQty: Math.max(0, r.outQty - r.returnQty),
  }));
}

function fmtDateOrDash(v) {
  if (!v) return '<span class="dash">—</span>';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return esc(String(v));
  const p = (n) => String(n).padStart(2, '0');
  return esc(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
}

function shipmentBoxHtml(orderNo) {
  const s = shipments.get(String(orderNo));
  const hasData = !!(s && (s.carrier || s.shipped_at || s.arrived_at || s.signed_at || s.tracking_no));
  const rows = hasData
    ? '<div class="ship-box">' +
        '<div class="ship-row"><span class="ship-k">物流商</span><span class="ship-v">' +
          (s.carrier ? esc(s.carrier) : '<span class="dash">—</span>') + '</span></div>' +
        '<div class="ship-row"><span class="ship-k">发货日期</span><span class="ship-v">' + fmtDateOrDash(s.shipped_at) + '</span></div>' +
        '<div class="ship-row"><span class="ship-k">到仓时间</span><span class="ship-v">' + fmtDateOrDash(s.arrived_at) + '</span></div>' +
        '<div class="ship-row"><span class="ship-k">签收时间</span><span class="ship-v">' + fmtDateOrDash(s.signed_at) + '</span></div>' +
        '<div class="ship-row"><span class="ship-k">国际单号</span><span class="ship-v mono">' +
          (s.tracking_no ? esc(s.tracking_no) : '<span class="dash">—</span>') + '</span></div>' +
      '</div>'
    : '<p class="hint">还没有发货记录，点下面按钮补录物流商与国际单号。</p>';

  return '<h3 class="report-sub">发货记录</h3>' + rows +
    '<div class="actions" style="margin-top:8px">' +
      '<button type="button" class="ghost small" data-ship="' + esc(orderNo) + '">' +
        (hasData ? '修改发货信息' : '录入发货信息') + '</button>' +
    '</div>';
}

function orderDetailHtml(r) {
  const rows = ordersRows.filter((m) => String(m.order_no) === String(r.order_no));
  const outs = rows.filter((m) => m.move_type === 'out');
  const returns = rows.filter((m) => m.move_type !== 'out' && m.is_return);
  const otherIns = rows.filter((m) => m.move_type !== 'out' && !m.is_return);

  const cell = (m, sign) => {
    const p = m.product || {};
    const qty = Number(m.quantity) || 0;
    const price = Number(m.unit_price) || 0;
    const unitCost = p ? (Number(p.cost_price) || 0) : 0;
    return '<tr' + (sign < 0 ? ' class="is-return"' : '') + '>' +
      '<td>' + esc(p.name || '（商品已删除）') +
        (p.code ? '<span class="dash"> ' + esc(p.code) + '</span>' : '') +
        (sign < 0 ? '<span class="badge ret">退货入库</span>' : '') + '</td>' +
      '<td class="num">' + (sign < 0 ? '-' : '') + qty + '</td>' +
      '<td class="num">' + fmtUsd(price) + '</td>' +
      '<td class="num">' + (sign < 0 ? '-' : '') + fmtUsd(qty * price) + '</td>' +
      '<td class="num">' + (sign < 0 ? '-' : '') + fmtMoney(qty * unitCost) + '</td>' +
    '</tr>';
  };

  const detailRows = outs.map((m) => cell(m, 1)).join('') + returns.map((m) => cell(m, -1)).join('');

  // 退回库存：按商品给可退数量，退错了也能从流水页看到退货记录
  const lines = orderProductLines(r.order_no);
  const returnBox = lines.filter((l) => l.outQty > 0).length
    ? '<h3 class="report-sub">退回库存</h3><div class="return-list">' +
      lines.filter((l) => l.outQty > 0).map((l) =>
        '<div class="return-row">' +
          '<div class="return-main"><span class="return-name">' + esc(l.name) + '</span>' +
            '<span class="return-meta">出库 ' + l.outQty + ' 件' +
            (l.returnQty > 0 ? ' · 已退回 ' + l.returnQty + ' 件' : '') + '</span></div>' +
          (l.netQty > 0
            ? '<button type="button" class="ghost small" data-return="' + esc(l.product_id) +
              '">退回 ' + l.netQty + ' 件</button>'
            : '<span class="badge ret">已全部退回</span>') +
        '</div>').join('') +
      '</div>'
    : '';

  return '<div class="detail-head">' +
      '<p class="detail-no">' + esc(r.order_no) + '</p>' +
      '<p class="detail-sub">客户 <b>' + (r.buyer ? esc(r.buyer) : '—') + '</b> · ' +
        r.moves + ' 笔出库 · ' + r.qty + ' 件' +
        (r.returnQty > 0 ? '（已退 ' + r.returnQty + ' 件）' : '') +
        ' · ' + esc(fmtRange(r.firstAt, r.lastAt)) + '</p>' +
    '</div>' +
    orderSumCardHtml(r) +
    shipmentBoxHtml(r.order_no) +
    (outs.length || returns.length
      ? '<h3 class="report-sub">商品明细</h3>' +
        '<div class="report-table-wrap"><table class="report-table">' +
          '<thead><tr><th>商品</th><th class="num">数量</th><th class="num">成交单价</th>' +
            '<th class="num">小计</th><th class="num">成本</th></tr></thead>' +
          '<tbody>' + detailRows + '</tbody>' +
        '</table></div>'
      : '') +
    (returns.length ? '<p class="hint">负数是退回库存的记录（已从本单金额与成本里扣掉）。</p>' : '') +
    returnBox +
    (otherIns.length ? '<p class="hint">本单另有 ' + otherIns.length + ' 笔普通入库记录，不计入订单金额与利润。</p>' : '') +
    '<div class="actions">' +
      '<button type="button" class="ghost small" data-edit-buyer="' + esc(r.order_no) + '">修改客户姓名</button>' +
      '<button type="button" class="ghost small" data-goto-moves="' + esc(r.order_no) +
        '">在流水页查看</button>' +
      '<button type="button" class="ghost small" data-copy-order="' + esc(r.order_no) +
        '">复制订单 ID</button>' +
      '<button type="button" class="danger small" data-del-order="' + esc(r.order_no) +
        '">删除订单</button>' +
    '</div>';
}

/* ---------- 订单可修改的三件事：客户姓名 / 发货记录 / 退回库存 ---------- */

function openEditBuyerDialog(orderNo) {
  const r = ordersAgg.filter((x) => String(x.order_no) === String(orderNo))[0];
  const body =
    '<p class="hint">修改后，该订单下所有出库流水的客户姓名会一起更新。</p>' +
    '<label class="field"><span>客户姓名</span><input id="obName" type="text" maxlength="24" placeholder="选填" value="' +
      esc(r && r.buyer ? r.buyer : '') + '"></label>';

  openModal('修改客户姓名 · ' + orderNo, body, async () => {
    const name = $('obName').value.trim();
    const upd = await cloud.database.from('stock_moves')
      .update({ buyer_name: name || null })
      .eq('order_no', orderNo)
      .eq('move_type', 'out')
      .select();
    if (upd.error) { $('modalError').textContent = describeDbError(upd.error); return true; }
    if (!Array.isArray(upd.data) || upd.data.length === 0) {
      $('modalError').textContent = '没有找到该订单的出库流水，请刷新后重试';
      return true;
    }
    toast(name ? '客户姓名已改为「' + name + '」' : '已清空客户姓名');
    await loadOrders();
    return false;
  });
}

function openShipmentDialog(orderNo) {
  const s = shipments.get(String(orderNo)) || {};
  const day = (v) => (v ? String(v).slice(0, 10) : '');
  const body =
    '<p class="hint">一个订单一条发货记录；五项全部留空保存 = 清除这条记录。</p>' +
    '<label class="field"><span>物流商</span><input id="shCarrier" type="text" placeholder="例如：燕文 / 云途 / 4PX" value="' + esc(s.carrier || '') + '"></label>' +
    '<label class="field"><span>发货日期</span><input id="shShipped" type="date" value="' + day(s.shipped_at) + '"></label>' +
    '<label class="field"><span>到仓时间</span><input id="shArrived" type="date" value="' + day(s.arrived_at) + '"></label>' +
    '<label class="field"><span>签收时间</span><input id="shSigned" type="date" value="' + day(s.signed_at) + '"></label>' +
    '<label class="field"><span>国际单号</span><input id="shTracking" type="text" placeholder="选填" value="' + esc(s.tracking_no || '') + '"></label>';

  openModal('发货信息 · ' + orderNo, body, async () => {
    const payload = {
      order_no: orderNo,
      carrier: $('shCarrier').value.trim() || null,
      shipped_at: $('shShipped').value || null,
      arrived_at: $('shArrived').value || null,
      signed_at: $('shSigned').value || null,
      tracking_no: $('shTracking').value.trim() || null,
      updated_at: new Date().toISOString(),
    };
    const cleared = !payload.carrier && !payload.shipped_at && !payload.arrived_at &&
      !payload.signed_at && !payload.tracking_no;

    const upd = await cloud.database.from('order_shipments')
      .update(payload).eq('order_no', orderNo).select();
    if (upd.error) { $('modalError').textContent = describeDbError(upd.error); return true; }
    if (!Array.isArray(upd.data) || upd.data.length === 0) {
      const ins = await cloud.database.from('order_shipments').insert(payload).select();
      if (ins.error) { $('modalError').textContent = describeDbError(ins.error); return true; }
      if (!Array.isArray(ins.data) || ins.data.length === 0) {
        $('modalError').textContent = '保存失败，请重试';
        return true;
      }
      shipments.set(String(orderNo), ins.data[0]);
    } else {
      shipments.set(String(orderNo), upd.data[0]);
    }
    toast(cleared ? '已清除该订单的发货记录' : '发货信息已保存');
    renderOrderDetail();
    return false;
  });
}

/* 摊销：把这一单没卖掉的商品退回库存，同时冲减本单金额与利润 */
function openReturnDialog(orderNo, productId) {
  const line = orderProductLines(orderNo)
    .filter((l) => String(l.product_id) === String(productId))[0];
  if (!line || line.netQty <= 0) { toast('该商品在本单没有可退回的数量'); return; }

  const body =
    '<p class="hint">' + esc(line.name) + '：本单出库 ' + line.outQty + ' 件' +
      (line.returnQty > 0 ? '，已退回 ' + line.returnQty + ' 件' : '') +
      '，可退回 ' + line.netQty + ' 件。<br>' +
      '退回后库存立即加回，本单的金额、成本与利润按退回数量冲减（按最后一笔出库单价 ' +
      fmtUsd(line.lastPrice) + ' 计）。</p>' +
    '<label class="field"><span>退回数量</span><input id="rqQty" type="number" min="1" step="1" value="' + line.netQty + '"></label>';

  openModal('退回库存 · ' + orderNo, body, async () => {
    const qty = Math.round(toNum($('rqQty').value));
    if (qty <= 0) { $('modalError').textContent = '退回数量必须大于 0'; return true; }
    if (qty > line.netQty) { $('modalError').textContent = '最多只能退回 ' + line.netQty + ' 件'; return true; }

    const pr = await cloud.database.from('products').select('id, stock').eq('id', line.product_id).maybeSingle();
    if (pr.error || !pr.data) { $('modalError').textContent = '读取商品库存失败，请重试'; return true; }
    const cur = Number(pr.data.stock) || 0;

    const ins = await cloud.database.from('stock_moves').insert({
      product_id: line.product_id,
      move_type: 'in',
      quantity: qty,
      unit_price: line.lastPrice,
      order_no: orderNo,
      is_return: true,
      buyer_note: '订单退回库存',
    });
    if (ins.error) { $('modalError').textContent = describeDbError(ins.error); return true; }

    const nowIso = new Date().toISOString();
    const upd = await cloud.database.from('products')
      .update({ stock: cur + qty, last_in_at: nowIso, updated_at: nowIso })
      .eq('id', line.product_id).select();
    if (upd.error) {
      $('modalError').textContent = '退货流水已记录，但库存更新失败：' + describeDbError(upd.error);
      return true;
    }
    if (!Array.isArray(upd.data) || upd.data.length === 0) {
      $('modalError').textContent = '库存更新未生效，请刷新后重试';
      return true;
    }

    toast('已退回 ' + qty + ' 件到库存，本单金额与利润同步冲减');
    await loadOrders();
    return false;
  });
}

/* ================= 统计报表 =================
   口径：只统计出库流水（move_type = 'out'）
   销售额 = 出库数量 × 成交单价（流水里存的 unit_price）
   毛利   = 销售额 - 数量 × 商品当前进价（进价改过会随之变化，属估算）
   毛利率 = 毛利 ÷ 销售额（销售额为 0 或净退货为负时不显示，避免出现没意义的百分比）
   分组   = 按浏览器本地时区把 created_at 归到「日 / 月 / 年」
   ============================================================ */

const REPORT_LIMIT = 3000;

/* 毛利率：只有销售额大于 0 才算得出，否则返回 null 由渲染层显示「—」 */
function marginOf(sales, profit) {
  return sales > 0 ? profit / sales : null;
}

/* 毛利率文案：保留一位小数，如 41.2%；分母不成立时显示「—」 */
function fmtMargin(m) {
  return m == null ? '—' : (m * 100).toFixed(1) + '%';
}

let reportMode = 'day';        // day | month | year
let reportYear = null;
let reportMonth = null;
let reportRows = [];
let reportEarliestYear = null;

function pad2(n) { return String(n).padStart(2, '0'); }

function initReportDefaults() {
  if (reportYear == null) {
    const now = new Date();
    reportYear = now.getFullYear();
    reportMonth = now.getMonth() + 1;
  }
}

/* 当前选择对应的查询区间（左闭右开，用本地时间构造再转 ISO） */
function reportRange() {
  if (reportMode === 'year') return { from: null, to: null };
  if (reportMode === 'month') {
    return { from: new Date(reportYear, 0, 1), to: new Date(reportYear + 1, 0, 1) };
  }
  return {
    from: new Date(reportYear, reportMonth - 1, 1),
    to: new Date(reportYear, reportMonth, 1),
  };
}

function reportRangeText() {
  if (reportMode === 'day') return reportYear + ' 年 ' + reportMonth + ' 月 · 按日统计';
  if (reportMode === 'month') return reportYear + ' 年 · 按月统计';
  return '全部年份 · 按年统计';
}

function bucketKeyOf(date) {
  if (reportMode === 'year') return String(date.getFullYear());
  if (reportMode === 'month') return date.getFullYear() + '-' + pad2(date.getMonth() + 1);
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

/* 周期骨架：即使某天 / 某月没有销售，也保留位置，图表才不会跳 */
function reportBuckets() {
  const list = [];
  if (reportMode === 'day') {
    const days = new Date(reportYear, reportMonth, 0).getDate();
    for (let d = 1; d <= days; d++) {
      list.push({
        key: reportYear + '-' + pad2(reportMonth) + '-' + pad2(d),
        label: reportMonth + '/' + d,
        full: reportYear + '-' + pad2(reportMonth) + '-' + pad2(d),
      });
    }
    return list;
  }
  if (reportMode === 'month') {
    for (let m = 1; m <= 12; m++) {
      list.push({
        key: reportYear + '-' + pad2(m),
        label: m + '月',
        full: reportYear + ' 年 ' + m + ' 月',
      });
    }
    return list;
  }
  const current = new Date().getFullYear();
  const start = Math.min(reportEarliestYear == null ? current : reportEarliestYear, current);
  for (let y = start; y <= current; y++) {
    list.push({ key: String(y), label: y + '年', full: y + ' 年' });
  }
  return list;
}

function reportPeriodName() {
  if (reportMode === 'day') return '日期';
  if (reportMode === 'month') return '月份';
  return '年份';
}

function aggregateReport(rows) {
  const buckets = new Map();
  reportBuckets().forEach((b) => buckets.set(b.key, {
    key: b.key, label: b.label, full: b.full,
    sales: 0, qty: 0, orders: 0, profit: 0,
  }));

  const rate = rateOf();
  const byProduct = new Map();
  const total = { sales: 0, qty: 0, orders: 0, profit: 0, orphan: 0, zeroCost: 0, returns: 0, returnQty: 0 };

  rows.forEach((m) => {
    const d = new Date(m.created_at);
    if (Number.isNaN(d.getTime())) return;
    // 只统计落在当前周期内的记录：合计与排行都以这份数据为准，
    // 不依赖查询区间是否恰好裁剪干净
    const b = buckets.get(bucketKeyOf(d));
    if (!b) return;

    // 退货是入库记录，用负数量参与统计，才能把出库那一笔抵消掉
    const isReturn = !!m.is_return;
    const sign = isReturn ? -1 : 1;
    const qty = (Number(m.quantity) || 0) * sign;
    const price = Number(m.unit_price) || 0;
    const p = m.product || null;
    const unitCost = p ? (Number(p.cost_price) || 0) : 0;
    // 成交单价是美元，先折成人民币再减人民币成本，否则毛利没有意义
    const sales = qty * price * rate;
    const profit = p ? qty * (price * rate - unitCost) : 0;

    if (isReturn) { total.returns += 1; total.returnQty += -qty; }
    else total.orders += 1;
    if (!p) total.orphan += 1;
    // 进价为 0 或没填通常是忘了，此时毛利会被高估，单独提示
    if (p && !(unitCost > 0)) total.zeroCost += 1;

    total.sales += sales;
    total.qty += qty;
    total.profit += profit;

    b.sales += sales;
    b.qty += qty;
    if (!isReturn) b.orders += 1;
    b.profit += profit;

    const pid = m.product_id == null ? '__orphan__' : String(m.product_id);
    let r = byProduct.get(pid);
    if (!r) {
      r = { name: p ? p.name : '（商品已删除）', code: p ? p.code : '', qty: 0, sales: 0, profit: 0 };
      byProduct.set(pid, r);
    }
    r.qty += qty;
    r.sales += sales;
    r.profit += profit;
  });

  return {
    list: Array.from(buckets.values()),
    products: Array.from(byProduct.values())
      .filter((x) => x.qty !== 0)
      .sort((a, b) => b.sales - a.sales),
    total,
    rate,
  };
}

function statCardsHtml(t) {
  const profitNotes = [];
  if (t.orphan > 0) profitNotes.push(t.orphan + ' 笔商品已删除，未计入');
  if (t.zeroCost > 0) profitNotes.push(t.zeroCost + ' 笔商品未填进价，偏高');
  if (t.returns > 0) profitNotes.push(t.returns + ' 笔退货已冲减');
  const cards = [
    { label: '销售额', value: fmtMoney(t.sales), note: '成交价按 $1≈¥' + fmtRate() + ' 折算' },
    { label: '销售件数', value: t.qty + ' 件', note: '' },
    { label: '出库笔数', value: t.orders + ' 笔', note: '' },
    {
      label: '估算毛利',
      value: fmtMoney(t.profit),
      note: profitNotes.length ? profitNotes.join('；') : '按商品当前进价估算',
    },
    {
      label: '毛利率',
      value: fmtMargin(marginOf(t.sales, t.profit)),
      note: '估算毛利 ÷ 销售额',
    },
  ];
  return '<div class="stat-grid">' + cards.map((c) =>
    '<div class="stat-card">' +
      '<p class="stat-label">' + c.label + '</p>' +
      '<p class="stat-value">' + c.value + '</p>' +
      (c.note ? '<p class="stat-note">' + esc(c.note) + '</p>' : '') +
    '</div>'
  ).join('') + '</div>';
}

function chartHtml(list) {
  const max = list.reduce((m, b) => Math.max(m, b.sales), 0);
  if (max <= 0) return '<p class="empty">该周期还没有销售记录</p>';
  // 柱子多的时候（按日最多 31 根）隔几个标一次，避免标签挤在一起
  const step = list.length > 14 ? Math.ceil(list.length / 10) : 1;
  return '<div class="chart">' + list.map((b, i) => {
    const h = b.sales > 0 ? Math.max(2, (b.sales / max) * 100) : 0;
    const tip = b.full + '：' + fmtMoney(b.sales) + ' · ' + b.qty + ' 件 · ' + b.orders + ' 笔';
    const showLabel = i % step === 0 || i === list.length - 1;
    return '<div class="bar-col" title="' + esc(tip) + '">' +
      '<div class="bar-track"><div class="bar" style="height:' + h.toFixed(1) + '%"></div></div>' +
      '<span class="bar-label">' + (showLabel ? esc(b.label) : '') + '</span>' +
    '</div>';
  }).join('') + '</div>';
}

function rankHtml(products) {
  if (products.length === 0) return '';
  const top = products.slice(0, 10);
  const max = top[0].sales || 1;
  return '<h3 class="report-sub">商品销售排行</h3>' +
    '<div class="rank-list">' + top.map((p, i) => {
      const w = Math.max(2, (p.sales / max) * 100);
      return '<div class="rank-row">' +
        '<span class="rank-no">' + (i + 1) + '</span>' +
        '<div class="rank-main">' +
          '<div class="rank-head">' +
            '<span class="rank-name">' + esc(p.name) + '</span>' +
            '<span class="rank-val">' + fmtMoney(p.sales) + '</span>' +
          '</div>' +
          '<div class="rank-bar-track"><div class="rank-bar" style="width:' + w.toFixed(1) + '%"></div></div>' +
          '<p class="rank-meta">售出 ' + p.qty + ' 件' + (p.code ? ' · ' + esc(p.code) : '') +
            ' · 毛利率 ' + fmtMargin(marginOf(p.sales, p.profit)) + '</p>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
}

function tableHtml(list) {
  const rows = list.slice().reverse();   // 最近的在上面
  return '<h3 class="report-sub">明细</h3>' +
    '<div class="report-table-wrap"><table class="report-table">' +
      '<thead><tr>' +
        '<th>' + reportPeriodName() + '</th>' +
        '<th class="num">销售额</th>' +
        '<th class="num">件数</th>' +
        '<th class="num">笔数</th>' +
        '<th class="num">估算毛利</th>' +
        '<th class="num">毛利率</th>' +
      '</tr></thead>' +
      '<tbody>' + rows.map((b) =>
        '<tr' + (b.orders === 0 ? ' class="is-empty"' : '') + '>' +
          '<td>' + esc(b.full) + '</td>' +
          '<td class="num">' + fmtMoney(b.sales) + '</td>' +
          '<td class="num">' + b.qty + '</td>' +
          '<td class="num">' + b.orders + '</td>' +
          '<td class="num">' + fmtMoney(b.profit) + '</td>' +
          '<td class="num">' + fmtMargin(marginOf(b.sales, b.profit)) + '</td>' +
        '</tr>'
      ).join('') + '</tbody>' +
    '</table></div>';
}

function renderReport() {
  const body = $('reportBody');
  if (!body) return;
  $('reportRangeLabel').textContent = reportRangeText();
  const { list, products, total } = aggregateReport(reportRows);
  body.innerHTML = statCardsHtml(total) + chartHtml(list) + rankHtml(products) + tableHtml(list);
}

/* 取最早一笔出库的年份，用于「按年」视图的年份范围 */
async function ensureReportEarliestYear() {
  if (reportEarliestYear != null) return;
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
      if (!Number.isNaN(d.getTime())) reportEarliestYear = d.getFullYear();
    }
  } catch (e) { /* 取不到就按当前年份处理 */ }
  if (reportEarliestYear == null) reportEarliestYear = new Date().getFullYear();
}

function syncReportSelectors() {
  const yearSel = $('reportYearSelect');
  const monthSel = $('reportMonthSelect');
  if (!yearSel || !monthSel) return;

  const current = new Date().getFullYear();
  const start = Math.min(reportEarliestYear == null ? current : reportEarliestYear, current);

  if (yearSel.dataset.start !== String(start)) {
    yearSel.innerHTML = '';
    for (let y = current; y >= start; y--) {
      const o = document.createElement('option');
      o.value = String(y);
      o.textContent = y + ' 年';
      yearSel.appendChild(o);
    }
    yearSel.dataset.start = String(start);
  }
  yearSel.value = String(reportYear);

  if (monthSel.options.length === 0) {
    for (let m = 1; m <= 12; m++) {
      const o = document.createElement('option');
      o.value = String(m);
      o.textContent = m + ' 月';
      monthSel.appendChild(o);
    }
  }
  monthSel.value = String(reportMonth);

  yearSel.classList.toggle('hidden', reportMode === 'year');
  monthSel.classList.toggle('hidden', reportMode !== 'day');
}

async function loadReport() {
  const body = $('reportBody');
  if (body) body.innerHTML = '<p class="empty">加载中…</p>';

  initReportDefaults();
  await ensureReportEarliestYear();
  syncReportSelectors();

  const range = reportRange();
  const cols = 'quantity, unit_price, created_at, product_id, move_type, is_return, ' +
    'product:products(id, name, code, cost_price)';
  // 两份数据合并：出库流水 + 为订单退回库存的入库流水（退货要冲减当天的业绩）
  let outQuery = cloud.database.from('stock_moves').select(cols).eq('move_type', 'out');
  let retQuery = cloud.database.from('stock_moves').select(cols)
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
      if (body) body.innerHTML = '<p class="empty">' + esc(describeDbError(outRes.error)) + '</p>';
      return;
    }
    const outs = Array.isArray(outRes.data) ? outRes.data : [];
    const rets = (retRes && !retRes.error && Array.isArray(retRes.data)) ? retRes.data : [];
    reportRows = outs.concat(rets);
    renderReport();
    if (outs.length >= REPORT_LIMIT) {
      toast('数据较多，仅统计最近 ' + REPORT_LIMIT + ' 笔出库');
    }
  } catch (err) {
    if (body) body.innerHTML = '<p class="empty">加载失败，请重试</p>';
  }
}

/* ================= 弹窗 ================= */

let modalHandler = null;

function openModal(title, bodyHtml, onOk, okText) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  $('modalError').textContent = '';
  $('modalOk').textContent = okText || '确定';
  modalHandler = onOk;
  $('modal').classList.remove('hidden');
  const first = $('modalBody').querySelector('input');
  if (first) setTimeout(() => first.focus(), 30);
}

function closeModal() {
  $('modal').classList.add('hidden');
  $('modalBody').innerHTML = '';
  $('modalError').textContent = '';
  modalHandler = null;
}

async function onModalOk() {
  if (!modalHandler) return;
  const btn = $('modalOk');
  btn.disabled = true;
  try {
    const keepOpen = await modalHandler();
    if (!keepOpen) closeModal();
  } catch (err) {
    $('modalError').textContent = (err && err.message) || '操作失败，请重试';
  } finally {
    btn.disabled = false;
  }
}

/* ================= 事件绑定与启动 ================= */

function bindEvents() {
  $('phoneInput').addEventListener('input', onPhoneInput);
  $('phoneInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCode(); });
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('sendCodeBtn').addEventListener('click', sendCode);
  $('loginBtn').addEventListener('click', doLogin);

  $('logoutBtn').addEventListener('click', async () => {
    try { await cloud.auth.signOut(); } catch (e) { /* 忽略 */ }
    showView('login');
  });

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  $('uploadZone').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => onFileChosen(e.target.files && e.target.files[0]));
  bindPhotoDropZone();
  $('recognizeBtn').addEventListener('click', recognize);
  $('clearPhotoBtn').addEventListener('click', resetCreate);
  $('resetCreateBtn').addEventListener('click', resetCreate);
  $('saveProductBtn').addEventListener('click', saveProduct);
  // 填进价自动带出默认售价；手动改过售价则不再覆盖
  $('fCost').addEventListener('input', autoFillSaleFromCost);
  $('fSale').addEventListener('input', () => {
    saleManuallyEdited = $('fSale').value.trim() !== '';
  });

  // 订单出库：填订单 ID + 客户姓名 → 开始出库 → 逐件出库 → 出库结束
  $('startOrderBtn').addEventListener('click', startOrder);
  $('endOrderBtn').addEventListener('click', endOrder);
  $('orderInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') startOrder(); });
  $('orderBuyerInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') startOrder(); });

  $('searchInput').addEventListener('input', renderInventory);
  $('refreshInventoryBtn').addEventListener('click', loadInventory);
  // 右上角汇率：售价（美元）折算成人民币的口径，随时可改
  $('rateBtn').addEventListener('click', openRateDialog);

  // 左侧品牌栏：点哪个品牌就只看哪个品牌的商品
  $('brandSidebar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-brand]');
    if (!btn || btn.dataset.brand === brandFilter) return;
    brandFilter = btn.dataset.brand;
    renderBrandSidebar();
    renderInventory();
  });
  $('refreshMovesBtn').addEventListener('click', loadMoves);
  // 全部 / 只看入库 / 只看出库
  $('moveKindSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kind]');
    if (!btn || btn.dataset.kind === moveKindFilter) return;
    setMoveKind(btn.dataset.kind);
  });
  $('moveBuyerInput').addEventListener('input', renderMoves);
  $('moveProductInput').addEventListener('input', renderMoves);
  // 订单筛选标签本身可点：点一下就取消「只看该订单」，其余筛选保留
  $('moveOrderFilter').addEventListener('click', () => {
    moveOrderFilter = '';
    renderOrderFilterTag();
    renderMoves();
  });
  $('clearMoveFilterBtn').addEventListener('click', clearMoveFilter);

  // 订单管理：左侧列表选订单 → 右侧看明细与成本利润
  $('orderSearchInput').addEventListener('input', renderOrders);
  $('orderSortSelect').addEventListener('change', () => {
    ordersSort = $('orderSortSelect').value || 'time';
    renderOrders();
  });
  $('refreshOrdersBtn').addEventListener('click', loadOrders);

  $('ordersList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-order-row]');
    if (!row) return;
    const no = row.dataset.orderRow;
    // 再点一次同一个订单 = 收起详情
    selectedOrderNo = String(no) === String(selectedOrderNo) ? null : no;
    renderOrders();
  });

  $('orderDetail').addEventListener('click', async (e) => {
    const cost = e.target.closest('[data-cost]');
    if (cost) { openOrderCostDialog(cost.dataset.cost); return; }

    const ret = e.target.closest('[data-return]');
    if (ret) { openReturnDialog(selectedOrderNo, ret.dataset.return); return; }

    const ship = e.target.closest('[data-ship]');
    if (ship) { openShipmentDialog(ship.dataset.ship); return; }

    const editBuyer = e.target.closest('[data-edit-buyer]');
    if (editBuyer) { openEditBuyerDialog(editBuyer.dataset.editBuyer); return; }

    const goto = e.target.closest('[data-goto-moves]');
    if (goto) {
      switchTab('moves');
      setMoveOrderFilter(goto.dataset.gotoMoves);
      return;
    }

    const copy = e.target.closest('[data-copy-order]');
    if (copy) {
      const value = copy.dataset.copyOrder;
      try {
        await navigator.clipboard.writeText(value);
        toast('已复制订单 ID：' + value);
      } catch (err) {
        toast('复制失败，请手动选中：' + value);
      }
      return;
    }

    const delOrder = e.target.closest('[data-del-order]');
    if (delOrder) {
      const no = delOrder.dataset.delOrder;
      openModal('删除订单',
        '<p class="hint">订单 ' + esc(no) + ' 的全部出入库流水会一并删除，'
          + '相关商品库存自动回补，其他成本与发货记录一并清除。删除后无法恢复，确定删除？</p>',
        async () => {
          await deleteOrderFlow(no);
          return false;
        }, '删除');
    }
  });

  // 统计报表：按日 / 按月 / 按年 切换，年份月份可单独选
  $('reportModeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn || btn.dataset.mode === reportMode) return;
    reportMode = btn.dataset.mode;
    document.querySelectorAll('#reportModeSeg .seg-btn').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.mode === reportMode);
    });
    loadReport();
  });
  $('reportYearSelect').addEventListener('change', () => {
    reportYear = Number($('reportYearSelect').value) || reportYear;
    loadReport();
  });
  $('reportMonthSelect').addEventListener('change', () => {
    reportMonth = Number($('reportMonthSelect').value) || reportMonth;
    loadReport();
  });
  $('refreshReportBtn').addEventListener('click', loadReport);

  $('inventoryList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const product = inventoryCache.find((p) => String(p.id) === String(btn.dataset.id));
    if (!product) return;
    const act = btn.dataset.act;
    if (act === 'out') {
      // 兜底：缺货 / 已归档商品禁止出库（按钮已置灰或不存在，这里再拦一道）
      if (product.archived) {
        toast('「' + product.name + '」已归档，先在「已归档」里恢复上架再出库');
        return;
      }
      if (Number(product.stock) <= 0) {
        toast('「' + product.name + '」已缺货，请先补货再出库');
        return;
      }
      openMoveDialog(product, 'out');
    }
    else if (act === 'in') {
      if (product.archived) {
        toast('「' + product.name + '」已归档，先恢复上架再补货');
        return;
      }
      openMoveDialog(product, 'in');
    }
    else if (act === 'edit') openEditDialog(product);
    else if (act === 'archive') openArchiveDialog(product);
    else if (act === 'restore') openRestoreDialog(product);
  });

  // 「已归档」切换：在售 / 已归档两个视图来回切，切完重算品牌与列表
  $('archivedToggleBtn').addEventListener('click', () => {
    archivedView = !archivedView;
    if (brandFilter !== ALL_BRANDS && !buildBrandStats().some((s) => s.key === brandFilter)) {
      brandFilter = ALL_BRANDS;
    }
    syncArchivedToggle();
    renderBrandSidebar();
    renderInventory();
    hydrateThumbs();
  });

  // 订单结算卡上的「录入 / 修改其他成本」
  $('orderSummary').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cost]');
    if (btn) openOrderCostDialog(btn.dataset.cost);
  });

  $('movesList').addEventListener('click', (e) => {
    // 点流水里的订单号 → 只看该订单的流水
    const chip = e.target.closest('[data-order]');
    if (chip) setMoveOrderFilter(chip.dataset.order);
  });

  $('modalOk').addEventListener('click', onModalOk);
  $('modalCancel').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
}

async function boot() {
  bindEvents();
  renderOrderFilterTag();
  renderMoveKindSeg();
  renderRateBtn();
  // 恢复「正在为某订单出库」的状态（刷新页面不该丢）
  activeOrder = loadActiveOrder();
  renderOrderBar();
  try {
    const { data: session } = await cloud.auth.getSession();
    if (session) await enterApp();
    else showView('login');
  } catch (e) {
    showView('login');
  }
}

boot();
