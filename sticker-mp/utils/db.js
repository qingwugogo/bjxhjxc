/* ============================================================
   数据访问层：所有表的读写都收在这里，页面只处理展示
   ============================================================ */

const { cloud } = require('./cloud');
const { pad2 } = require('./format');

const MOVE_COLS = '*, product:products(id, name, code, cost_price)';

async function currentUserId() {
  try {
    const { data: session } = await cloud.auth.getSession();
    return (session && session.user && session.user.id) || null;
  } catch (e) {
    return null;
  }
}

/* ---------- 商品 ---------- */

async function listProducts() {
  return cloud.database.from('products').select('*').order('created_at', { ascending: false });
}

/* 生成产品编码：SP + 年月日 + 3 位当日序号
   序号取「当天已用编码里的最大序号 + 1」，不能按当天商品条数来算——
   条数会随商品被删除而回退，导致新商品拿到已用过的编码。
   数据库侧另有 UNIQUE(owner_id, code) 约束兜底。 */
async function generateCode() {
  const now = new Date();
  const stamp = '' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate());
  const prefix = 'SP' + stamp;

  let maxSeq = 0;
  try {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const res = await cloud.database.from('products').select('code').gte('created_at', startOfDay);
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

/* 编码若与已有商品冲突（并发录入 / 手动填了重复值），自动换新编码重试 */
async function createProduct(payload) {
  let finalCode = payload.code;
  let codeChanged = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ins = await cloud.database
      .from('products')
      .insert(Object.assign({}, payload, { code: finalCode }))
      .select();
    if (!ins.error) {
      return { data: Array.isArray(ins.data) ? ins.data[0] : null, codeChanged };
    }
    const rawCode = String((ins.error && ins.error.code) || '');
    const rawMsg = String((ins.error && ins.error.message) || '');
    const isConflict = rawCode.indexOf('23505') >= 0 || rawMsg.indexOf('23505') >= 0;
    if (!isConflict) return { error: ins.error };
    finalCode = await generateCode();
    codeChanged = true;
  }
  return { error: { message: '产品编码重复，请手动修改「产品编码」后重试' } };
}

async function updateProduct(id, patch) {
  return cloud.database.from('products').update(patch).eq('id', id).select();
}

/* ---------- 删除 ---------- */

/* 删除商品：stock_moves 由外键 CASCADE 一并删除；
   照片对象尽力清理，失败不阻塞主流程 */
async function deleteProduct(product) {
  const del = await cloud.database.from('products').delete().eq('id', product.id);
  if (del.error) return { error: del.error };
  if (product.image_path) {
    try { await cloud.storage.remove([product.image_path]); } catch (e) { /* 存储清理失败不影响 */ }
  }
  return { data: true };
}

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

/* 删除整个订单：先按流水回补各商品库存，再删流水 + 其他成本 + 发货记录。
   顺序很重要：流水删掉之后就查不到该回补多少了 */
async function deleteOrder(orderNo) {
  const res = await cloud.database.from('stock_moves').select(MOVE_COLS).eq('order_no', orderNo);
  if (res.error) return { error: res.error };
  const moves = Array.isArray(res.data) ? res.data : [];
  if (moves.length === 0) {
    return { error: { message: '没有找到该订单的流水，可能已被删除' } };
  }

  /* 按商品汇总回补量 */
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
      const cur = await getProductStock(pid);
      if (cur.error || !cur.data) { stockFailed += 1; continue; }
      const next = Math.max(0, (Number(cur.data.stock) || 0) + delta);
      const upd = await updateProduct(pid, { stock: next, updated_at: new Date().toISOString() });
      if (upd.error) stockFailed += 1;
    } catch (e) {
      stockFailed += 1;
    }
  }

  const delMoves = await cloud.database.from('stock_moves').delete().eq('order_no', orderNo);
  if (delMoves.error) return { error: delMoves.error };

  /* 成本与发货记录删除失败不回滚（订单已删），只标记 */
  const costDel = await cloud.database.from('order_costs').delete().eq('order_no', orderNo);
  const shipDel = await cloud.database.from('order_shipments').delete().eq('order_no', orderNo);

  return {
    data: {
      moves: moves.length,
      stockFailed,
      auxFailed: (costDel.error ? 1 : 0) + (shipDel.error ? 1 : 0),
    },
  };
}

async function getProductStock(id) {
  return cloud.database.from('products').select('id, stock').eq('id', id).maybeSingle();
}

/* ---------- 流水 ---------- */

async function insertMove(move) {
  return cloud.database.from('stock_moves').insert(move);
}

/* 「开始出库」前按订单号查云端已有出库进度（退货冲减后）。
   查到 moves>0 即老订单，带出继续；查不到 / 失败返回 null 当新订单 */
async function getOrderSummary(orderNo) {
  try {
    const res = await cloud.database.from('stock_moves')
      .select('move_type,quantity,unit_price,is_return,buyer_name')
      .eq('order_no', orderNo)
      .limit(1000);
    if (res.error || !Array.isArray(res.data)) return null;
    let moves = 0, qty = 0, amount = 0, buyer = '';
    res.data.forEach((m) => {
      const q = Number(m.quantity) || 0;
      const pr = Number(m.unit_price) || 0;
      if (m.move_type === 'out') {
        moves += 1;
        qty += q;
        amount += q * pr;
        const b = String(m.buyer_name == null ? '' : m.buyer_name).trim();
        if (b) buyer = b;
      } else if (m.is_return) {
        qty = Math.max(0, qty - q);
        amount = Math.max(0, amount - q * pr);
      }
    });
    return { moves, qty, amount, buyer };
  } catch (e) {
    return null;
  }
}

/* 流水列表：最近 N 条（网页版口径 200 条） */
async function listMoves(limit) {
  return cloud.database
    .from('stock_moves')
    .select(MOVE_COLS)
    .order('created_at', { ascending: false })
    .limit(limit || 200);
}

/* 订单结算：走服务端按订单号模糊查询，不受列表窗口限制 */
async function listOrderMoves(keyword, options) {
  const opts = options || {};
  let q = cloud.database.from('stock_moves').select(MOVE_COLS);
  if (keyword) q = q.ilike('order_no', '%' + keyword + '%');
  return q.order('created_at', { ascending: opts.ascending !== false }).limit(opts.limit || 1000);
}

/* 订单管理页：一次拉全量（含商品进价）用于聚合 */
async function listAllOrderMoves(limit) {
  return cloud.database
    .from('stock_moves')
    .select(MOVE_COLS)
    .order('created_at', { ascending: true })
    .limit(limit || 2000);
}

/* ---------- 其他成本 / 发货 ---------- */

async function listOrderCosts() {
  const res = await cloud.database.from('order_costs').select('*').limit(1000);
  const map = new Map();
  if (!res.error && Array.isArray(res.data)) {
    res.data.forEach((r) => {
      map.set(String(r.order_no), {
        other_cost: Number(r.other_cost) || 0,
        cost_note: r.cost_note || '',
      });
    });
  }
  return map;
}

async function saveOrderCost(orderNo, otherCost, costNote) {
  const payload = {
    other_cost: otherCost,
    cost_note: costNote || null,
    updated_at: new Date().toISOString(),
  };
  const upd = await cloud.database.from('order_costs').update(payload).eq('order_no', orderNo).select();
  if (upd.error) return { error: upd.error };
  if (!Array.isArray(upd.data) || upd.data.length === 0) {
    const ins = await cloud.database.from('order_costs')
      .insert(Object.assign({ order_no: orderNo }, payload)).select();
    if (ins.error) return { error: ins.error };
    if (!Array.isArray(ins.data) || ins.data.length === 0) {
      return { error: { message: '保存失败，请重试' } };
    }
    return { data: ins.data[0] };
  }
  return { data: upd.data[0] };
}

async function listShipments() {
  const res = await cloud.database.from('order_shipments').select('*').limit(2000);
  const map = new Map();
  if (!res.error && Array.isArray(res.data)) {
    res.data.forEach((s) => map.set(String(s.order_no), s));
  }
  return map;
}

async function saveShipment(orderNo, payload) {
  const body = Object.assign({}, payload, { order_no: orderNo, updated_at: new Date().toISOString() });
  const upd = await cloud.database.from('order_shipments').update(body).eq('order_no', orderNo).select();
  if (upd.error) return { error: upd.error };
  if (!Array.isArray(upd.data) || upd.data.length === 0) {
    const ins = await cloud.database.from('order_shipments').insert(body).select();
    if (ins.error) return { error: ins.error };
    if (!Array.isArray(ins.data) || ins.data.length === 0) {
      return { error: { message: '保存失败，请重试' } };
    }
    return { data: ins.data[0] };
  }
  return { data: upd.data[0] };
}

/* ---------- 汇率 ---------- */

async function getRate() {
  try {
    const { data, error } = await cloud.database
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', 'usd_cny_rate')
      .maybeSingle();
    if (error || !data) return null;
    const n = Number(data.setting_value);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (e) {
    return null;
  }
}

async function saveRate(value) {
  const payload = {
    setting_key: 'usd_cny_rate',
    setting_value: String(value),
    updated_at: new Date().toISOString(),
  };
  const upd = await cloud.database.from('app_settings')
    .update(payload).eq('setting_key', 'usd_cny_rate').select();
  if (upd.error) return { error: upd.error };
  if (!Array.isArray(upd.data) || upd.data.length === 0) {
    const ins = await cloud.database.from('app_settings').insert(payload).select();
    if (ins.error) return { error: ins.error };
    if (!Array.isArray(ins.data) || ins.data.length === 0) {
      return { error: { message: '保存失败，请重试' } };
    }
  }
  return {};
}

/* ---------- 照片 ---------- */

function randomName() {
  return 'p' + Date.now() + Math.random().toString(36).slice(2, 8) + '.jpg';
}

async function uploadPhoto(filePath, contentType) {
  const userId = await currentUserId();
  if (!userId) return { error: { message: '登录已失效，请重新进入小程序' } };

  let body;
  try {
    body = wx.getFileSystemManager().readFileSync(filePath);
  } catch (e) {
    return { error: { message: '照片读取失败，请重新选择' } };
  }

  /* 共享模式：照片必须放在 shared/<uid>/ 下——所有登录用户可读；
     放 users/<uid>/ 只有上传者本人能读，别人看商品就是一片空白 */
  const path = cloud.storage.sharedPath(userId, 'products/' + randomName());
  const res = await cloud.storage.upload(path, body, { contentType: contentType || 'image/jpeg' });
  if (res && res.error) return { error: res.error };
  return { data: { path } };
}

/* 历史照片迁移：早期照片放在 users/<uid>/（只有本人能读），共享模式下别人看不到图。
   只有照片所有者能读自己的旧图，所以由「谁打开小程序」迁移谁名下的那几张；
   迁完 image_path 变成 shared/<uid>/...，幂等，没有待迁移项时零开销 */
async function migrateLegacyPhotos(products) {
  const uid = await currentUserId();
  if (!uid) return 0;
  const prefix = 'users/' + uid + '/';
  const targets = (products || []).filter((p) => p.image_path && p.image_path.indexOf(prefix) === 0);
  let moved = 0;
  for (const p of targets) {
    try {
      const signed = await cloud.storage.createSignedUrl(p.image_path, 600);
      const info = signed && signed.data;
      const url = info && (info.signedUrl || info.signedURL || info.url);
      if (!url) continue;
      const dl = await new Promise((resolve) => {
        wx.downloadFile({ url, success: resolve, fail: () => resolve(null) });
      });
      if (!dl || dl.statusCode !== 200) continue;
      const body = wx.getFileSystemManager().readFileSync(dl.tempFilePath);
      const newPath = cloud.storage.sharedPath(uid, 'products/' + randomName());
      const up = await cloud.storage.upload(newPath, body, { contentType: 'image/jpeg' });
      if (up && up.error) continue;
      const upd = await cloud.database.from('products')
        .update({ image_path: newPath }).eq('id', p.id);
      if (upd && upd.error) continue;
      p.image_path = newPath;
      moved += 1;
    } catch (e) { /* 单张失败不影响其它，下次进来再试 */ }
  }
  return moved;
}

/* 批量取缩略图签名地址：path -> url */async function signPhotoUrls(paths) {
  const list = (paths || []).filter(Boolean);
  const map = {};
  if (list.length === 0) return map;
  try {
    const res = await cloud.storage.createSignedUrls(list, 3600);
    if (res.error || !res.data) return map;
    (Array.isArray(res.data) ? res.data : []).forEach((item) => {
      const url = item.signedUrl || item.signedURL || item.url;
      const key = item.path || item.pathname;
      if (key && url) map[key] = url;
    });
  } catch (e) { /* 缩略图失败不影响主流程 */ }
  return map;
}

module.exports = {
  cloud,
  currentUserId,
  listProducts,
  generateCode,
  createProduct,
  updateProduct,
  deleteProduct,
  deleteOrder,
  stockDeltaForMove,
  getProductStock,
  insertMove,
  getOrderSummary,
  listMoves,
  listOrderMoves,
  listAllOrderMoves,
  listOrderCosts,
  saveOrderCost,
  listShipments,
  saveShipment,
  getRate,
  saveRate,
  uploadPhoto,
  migrateLegacyPhotos,
  signPhotoUrls,
};
