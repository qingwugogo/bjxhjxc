/* ============================================================
   格式化与纯计算工具
   与网页版保持同一套口径与文案
   ============================================================ */

const DEFAULT_USD_CNY = 7.2;
const LOW_STOCK_AT = 5;
/* 进货渠道固定选项（下拉选）；进货商预置项（可下拉选也可手填）。
   历史数据里出现过的值会自动追加到选项后面，保证旧值仍能选中 */
const CHANNEL_OPTIONS = ['拼多多', '小红书', '1688', '抖音'];
const SUPPLIER_PRESETS = ['悠米', '小时光'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/* 金额与数量都可能是 null / 空字符串 / 脏数据，统一兜底成 0 */
function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function fmtMoney(value) {
  const n = Number(value);
  return '¥' + (Number.isFinite(n) ? n.toFixed(2) : '0.00');
}

/* 售价 / 成交单价记的是美元，单独一套符号 */
function fmtUsd(value) {
  const n = Number(value);
  return '$' + (Number.isFinite(n) ? n.toFixed(2) : '0.00');
}

/* 没填的价格显示「未填」而不是 ¥0.00 —— 0 元和没填是两回事 */
function moneyOrDash(value) {
  return value == null || value === '' ? '未填' : fmtMoney(value);
}

function usdOrDash(value) {
  return value == null || value === '' ? '未填' : fmtUsd(value);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtTimeOrDash(iso) {
  return fmtTime(iso) || '—';
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* 订单内的时间范围：10-14 15:35 ~ 15:40 */
function fmtRange(from, to) {
  if (!from) return '';
  const a = new Date(from);
  if (Number.isNaN(a.getTime())) return '';
  const head = pad2(a.getMonth() + 1) + '-' + pad2(a.getDate()) + ' ' +
    pad2(a.getHours()) + ':' + pad2(a.getMinutes());
  if (!to || to === from) return head;
  const b = new Date(to);
  if (Number.isNaN(b.getTime())) return head;
  const sameDay = a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const tail = sameDay
    ? pad2(b.getHours()) + ':' + pad2(b.getMinutes())
    : pad2(b.getMonth() + 1) + '-' + pad2(b.getDate()) + ' ' + pad2(b.getHours()) + ':' + pad2(b.getMinutes());
  return head + ' ~ ' + tail;
}

/* 毛利率：只有销售额大于 0 才算得出，否则返回 null 由渲染层显示「—」 */
function marginOf(sales, profit) {
  return sales > 0 ? profit / sales : null;
}

function fmtMargin(m) {
  return m == null ? '—' : (m * 100).toFixed(1) + '%';
}

function fmtInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '0';
}

module.exports = {
  DEFAULT_USD_CNY,
  LOW_STOCK_AT,
  CHANNEL_OPTIONS,
  SUPPLIER_PRESETS,
  pad2,
  toNum,
  fmtMoney,
  fmtUsd,
  moneyOrDash,
  usdOrDash,
  fmtTime,
  fmtTimeOrDash,
  fmtDate,
  fmtRange,
  marginOf,
  fmtMargin,
  fmtInt,
};
