/* ============================================================
   业务统计（纯函数）
   ------------------------------------------------------------
   口径（与网页版一致）：
   - 销售额 = 出库数量 × 成交单价（美元）× 汇率
   - 商品成本 = 数量 × 商品当前进价（人民币）
   - 净利润 = 销售额 − 商品成本 − 其他成本
   - 退货（is_return 的入库）按原成交单价与当前进价反向冲减
   ============================================================ */

const {
  pad2, toNum, fmtMoney, fmtUsd, fmtRange, marginOf, fmtMargin,
} = require('./format');

const ALL_BRANDS = '__all__';
const NO_BRAND = '__none__';

function brandKeyOf(p) {
  const b = String((p && p.brand) || '').trim();
  return b || NO_BRAND;
}

/* 品牌不是单独的表，而是从已录入商品里自动汇总 */
function buildBrandStats(products) {
  const map = new Map();
  (products || []).forEach((p) => {
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
    if (a.key === NO_BRAND) return 1;
    if (b.key === NO_BRAND) return -1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return list;
}

/* ---------- 订单聚合 ---------- */

/* keyword 为空表示统计全部；只统计出库，入库单独计数 */
function buildOrderStats(rows, keyword, ctx) {
  const rate = (ctx && ctx.rate) || 7.2;
  const costs = (ctx && ctx.costs) || new Map();
  const kw = String(keyword == null ? '' : keyword).toLowerCase();
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
        buyer: '', lastBuyer: '', firstAt: null, lastAt: null,
        products: new Map(),
      };
      map.set(no, r);
    }

    const qty = Number(m.quantity) || 0;
    const price = Number(m.unit_price) || 0;
    const p = m.product || null;
    const unitCost = p ? (Number(p.cost_price) || 0) : 0;
    const pname = p ? p.name : '（商品已删除）';

    if (isReturn) {
      r.returnMoves += 1;
      r.returnQty += qty;
      r.returnSalesUsd += qty * price;
      r.returnCost += qty * unitCost;
      r.products.set(pname, (r.products.get(pname) || 0) - qty);
      return;
    }

    const buyerName = String(m.buyer_name == null ? '' : m.buyer_name).trim();
    if (buyerName) {
      if (!r.buyer) r.buyer = buyerName;
      r.lastBuyer = buyerName;
    }
    if (!p) r.orphanQty += qty;
    else if (!(unitCost > 0)) r.zeroCostMoves += 1;
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
    const extra = costs.get(String(r.order_no)) || { other_cost: 0, cost_note: '' };
    const other = Number(extra.other_cost) || 0;
    // 净额 = 出库 − 退货；max(0) 兜住退货多于出库的历史脏数据
    const qty = Math.max(0, r.qty - r.returnQty);
    const salesUsd = Math.max(0, r.salesUsd - r.returnSalesUsd);
    const cost = Math.max(0, r.cost - r.returnCost);
    const sales = salesUsd * rate;
    const net = sales - cost - other;
    return Object.assign(r, {
      qty, salesUsd, cost, sales, rate,
      otherCost: other,
      costNote: extra.cost_note || '',
      net,
      margin: marginOf(sales, net),
      productList: Array.from(r.products.entries())
        .filter((e) => e[1] > 0)
        .map((e) => ({ name: e[0], qty: e[1] })),
    });
  });

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

/* 订单结算卡 / 订单行的展示字段（避免 WXML 里做计算） */
function orderCardView(r) {
  const notes = [];
  if (r.costNote) notes.push('其他成本说明：' + r.costNote);
  if (r.returnQty > 0) notes.push('已退回库存 ' + r.returnQty + ' 件（金额与成本已按退货冲减）');
  if (r.zeroPriceMoves > 0) notes.push(r.zeroPriceMoves + ' 笔出库未填单价，订单金额偏低');
  if (r.orphanQty > 0) notes.push(r.orphanQty + ' 件商品已删除，成本未计入');
  if (r.zeroCostMoves > 0) notes.push(r.zeroCostMoves + ' 笔商品未填进价，成本可能偏低');

  const names = (r.productList || []).slice(0, 3).map((p) => p.name + ' ×' + p.qty);
  const productText = names.join('、') + ((r.productList || []).length > 3
    ? ' 等 ' + r.productList.length + ' 款' : '');

  return {
    orderNo: r.order_no,
    moves: r.moves,
    qty: r.qty,
    range: fmtRange(r.firstAt, r.lastAt),
    salesText: fmtMoney(r.sales),
    salesUsdText: fmtUsd(r.salesUsd),
    rateText: '× ' + Number(r.rate || 7.2).toFixed(2),
    costText: fmtMoney(r.cost),
    otherText: fmtMoney(r.otherCost),
    netText: fmtMoney(r.net),
    netClass: r.net > 0 ? 'is-net' : (r.net < 0 ? 'is-loss' : ''),
    marginText: r.margin == null ? '' : '毛利率 ' + fmtMargin(r.margin),
    productText,
    noteText: notes.join('；'),
    hasOther: r.otherCost > 0,
    costNote: r.costNote || '',
  };
}

/* 一个订单按商品汇总：出库数量、已退回数量、可退回数量、最后一笔出库单价 */
function orderProductLines(rows, orderNo) {
  const list = (rows || []).filter((m) => String(m.order_no) === String(orderNo));
  const map = new Map();
  list.forEach((m) => {
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

/* ---------- 统计报表 ---------- */

function reportRangeText(mode, year, month) {
  if (mode === 'day') return year + ' 年 ' + month + ' 月 · 按日统计';
  if (mode === 'month') return year + ' 年 · 按月统计';
  return '全部年份 · 按年统计';
}

function bucketKeyOf(date, mode) {
  if (mode === 'year') return String(date.getFullYear());
  if (mode === 'month') return date.getFullYear() + '-' + pad2(date.getMonth() + 1);
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

/* 周期骨架：即使某天 / 某月没有销售，也保留位置，图表才不会跳 */
function reportBuckets(mode, year, month, earliestYear) {
  const list = [];
  if (mode === 'day') {
    const days = new Date(year, month, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const key = year + '-' + pad2(month) + '-' + pad2(d);
      list.push({ key, label: month + '/' + d, full: key });
    }
    return list;
  }
  if (mode === 'month') {
    for (let m = 1; m <= 12; m++) {
      list.push({
        key: year + '-' + pad2(m),
        label: m + '月',
        full: year + ' 年 ' + m + ' 月',
      });
    }
    return list;
  }
  const current = new Date().getFullYear();
  const start = Math.min(earliestYear == null ? current : earliestYear, current);
  for (let y = start; y <= current; y++) {
    list.push({ key: String(y), label: y + '年', full: y + ' 年' });
  }
  return list;
}

function reportPeriodName(mode) {
  if (mode === 'day') return '日期';
  if (mode === 'month') return '月份';
  return '年份';
}

function aggregateReport(rows, ctx) {
  const mode = ctx.mode;
  const rate = ctx.rate || 7.2;
  const buckets = new Map();
  reportBuckets(mode, ctx.year, ctx.month, ctx.earliestYear).forEach((b) => {
    buckets.set(b.key, {
      key: b.key, label: b.label, full: b.full,
      sales: 0, qty: 0, orders: 0, profit: 0,
    });
  });

  const byProduct = new Map();
  const total = { sales: 0, qty: 0, orders: 0, profit: 0, orphan: 0, zeroCost: 0, returns: 0, returnQty: 0 };

  (rows || []).forEach((m) => {
    const d = new Date(m.created_at);
    if (Number.isNaN(d.getTime())) return;
    const b = buckets.get(bucketKeyOf(d, mode));
    if (!b) return;

    // 退货是入库记录，用负数量参与统计，才能把出库那一笔抵消掉；
    // 普通补货入库不属于销售，直接跳过（避免把进货款算成销售额）
    const isReturn = !!m.is_return;
    if (m.move_type !== 'out' && !isReturn) return;
    const sign = isReturn ? -1 : 1;
    const qty = (Number(m.quantity) || 0) * sign;
    const price = Number(m.unit_price) || 0;
    const p = m.product || null;
    const unitCost = p ? (Number(p.cost_price) || 0) : 0;
    const sales = qty * price * rate;
    const profit = p ? qty * (price * rate - unitCost) : 0;

    if (isReturn) { total.returns += 1; total.returnQty += -qty; }
    else total.orders += 1;
    if (!p) total.orphan += 1;
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

module.exports = {
  ALL_BRANDS,
  NO_BRAND,
  brandKeyOf,
  buildBrandStats,
  buildOrderStats,
  orderCardView,
  orderProductLines,
  reportRangeText,
  reportBuckets,
  reportPeriodName,
  aggregateReport,
  toNum,
};
