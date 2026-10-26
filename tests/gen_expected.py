#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重算 /tmp/mock/expected.json 的期望值。

口径（2026-10-16 起）：
  进价 = 人民币（商品成本直接用它）
  售价 / 成交单价 = 美元，统计时按汇率 RATE 折算成人民币
  订单金额 = Σ 出库数量 × 成交单价(USD) × RATE − Σ 退货数量 × 成交单价(USD) × RATE
  商品成本 = Σ 出库数量 × 当前进价 − Σ 退货数量 × 当前进价
  净利润   = 订单金额 − 商品成本 − 其他成本

金额类字段一律从 fixtures 原始数据独立算出（不复用页面输出），
非金额字段沿用上一版（它们与币种无关）。
"""
import json
import datetime

RATE = 7.2
SRC = '/tmp/mock/fixtures.json'
OUT = '/tmp/mock/expected.json'

fx = json.load(open(SRC, encoding='utf-8'))
prod = {p['id']: p for p in fx['products']}
costs = {c['order_no']: c for c in fx['costs']}
moves = sorted(fx['moves'], key=lambda m: m['created_at'])   # 与页面 order by created_at asc 一致
exp = json.load(open(OUT, encoding='utf-8'))


def dt(s):
    return datetime.datetime.fromisoformat(s)


def price_of(m):
    return float(m.get('unit_price') or 0)


def cost_of(m):
    p = prod.get(m['product_id']) or {}
    return float(p.get('cost_price') or 0)


def other_of(no):
    return float((costs.get(no) or {}).get('other_cost') or 0)


# ---------------- 流水窗口：服务端 order by created_at desc + limit 200 ----------------
window = sorted(moves, key=lambda m: m['created_at'], reverse=True)[:200]
with_order = lambda m: bool((m.get('order_no') or '').strip())
exp['window_total'] = len(window)
exp['window_chips'] = sum(1 for m in window if with_order(m))
exp['window_mk001_all'] = sum(1 for m in window if (prod[m['product_id']] or {}).get('code') == 'MK20261014001')
exp['window_mk001_out'] = sum(
    1 for m in window
    if (prod[m['product_id']] or {}).get('code') == 'MK20261014001' and m['move_type'] == 'out')
exp['window_jessica'] = sum(1 for m in window if 'jessica' in (m.get('buyer_name') or '').lower())
exp['window_phone555'] = 0     # 电话片段，姓名里不可能出现数字
exp['window_order1064'] = sum(1 for m in window if (m.get('order_no') or '') == 'MOCK-TK2026101064')
exp['window_orphan_out'] = sum(1 for m in window if not with_order(m) and m['move_type'] == 'out')
exp['window_in_total'] = sum(1 for m in window if m['move_type'] == 'in')


# ---------------- 订单聚合（口径同应用里的 buildOrderStats） ----------------
def order_agg():
    agg = {}
    for m in moves:
        no = (m.get('order_no') or '').strip()
        if not no:
            continue
        is_out = m['move_type'] == 'out'
        is_ret = bool(m.get('is_return'))
        if not is_out and not is_ret:
            continue
        r = agg.setdefault(no, dict(moves=0, qty=0, su=0.0, cost=0.0,
                                    rq=0, rsu=0.0, rc=0.0, buyer='', products={}))
        qty = int(m['quantity'] or 0)
        price = price_of(m)
        uc = cost_of(m)
        name = (prod.get(m['product_id']) or {}).get('name', '（商品已删除）')
        if is_ret:
            r['rq'] += qty
            r['rsu'] += qty * price
            r['rc'] += qty * uc
            r['products'][name] = r['products'].get(name, 0) - qty
        else:
            r['moves'] += 1
            r['qty'] += qty
            r['su'] += qty * price
            r['cost'] += qty * uc
            r['products'][name] = r['products'].get(name, 0) + qty
            bn = (m.get('buyer_name') or '').strip()
            if bn and not r['buyer']:
                r['buyer'] = bn
    out = {}
    for no, r in agg.items():
        qty = max(0, r['qty'] - r['rq'])
        su = max(0.0, r['su'] - r['rsu'])
        cost = max(0.0, r['cost'] - r['rc'])
        sales = su * RATE
        other = other_of(no)
        net = sales - cost - other
        out[no] = {
            'no': no, 'moves': r['moves'], 'qty': qty,
            'sales': sales, 'cost': cost, 'other': other, 'net': net,
            'margin': (net / sales if sales > 0 else None),
            'buyer': r['buyer'],
            'products': [[k, v] for k, v in r['products'].items() if v > 0],
        }
    return out


oagg = order_agg()


def pick(no, keys=('no', 'moves', 'qty', 'sales', 'cost', 'other', 'net', 'margin', 'buyer', 'products')):
    r = oagg[no]
    return {k: r[k] for k in keys}


# ---------------- 报表聚合（按出库 − 退货，金额折人民币） ----------------
def report_buckets():
    keys = {}

    def acc(mode, key, sales, qty, profit, counted):
        b = keys.setdefault((mode, key), dict(sales=0.0, qty=0, orders=0, profit=0.0))
        b['sales'] += sales
        b['qty'] += qty
        b['profit'] += profit
        if counted:
            b['orders'] += 1

    for m in moves:
        d = dt(m['created_at'])
        is_out = m['move_type'] == 'out'
        is_ret = bool(m.get('is_return'))
        if not is_out and not is_ret:
            continue      # 补货入库不进报表
        sign = -1 if is_ret else 1
        qty = int(m['quantity'] or 0) * sign
        price = price_of(m)
        uc = cost_of(m)
        sales = qty * price * RATE
        profit = qty * (price * RATE - uc)
        for mode, key in (('day', d.strftime('%Y-%m-%d')),
                          ('month', d.strftime('%Y-%m')),
                          ('year', d.strftime('%Y'))):
            acc(mode, key, sales, qty, profit, not is_ret)
    return keys


rb = report_buckets()


def r_of(mode, key):
    b = rb.get((mode, key), dict(sales=0.0, qty=0, orders=0, profit=0.0))
    return {k: b[k] for k in ('sales', 'qty', 'orders', 'profit')}


y25, y26 = r_of('year', '2025'), r_of('year', '2026')
exp['report'] = {
    'month202610': r_of('month', '2026-10'),
    'year2026': y26,
    'year2025': y25,
    'day20261014': r_of('day', '2026-10-14'),
    'all': {k: y25[k] + y26[k] for k in ('sales', 'qty', 'orders', 'profit')},
}


# ---------------- 商品排行 ----------------
def rank(rows):
    byp = {}
    for m in rows:
        if m['move_type'] != 'out':
            continue
        p = prod.get(m['product_id']) or {}
        name = p.get('name', '（商品已删除）')
        r = byp.setdefault(name, dict(qty=0, sales=0.0))
        q = int(m['quantity'] or 0)
        r['qty'] += q
        r['sales'] += q * price_of(m) * RATE
    ranked = sorted(byp.items(), key=lambda kv: -kv[1]['sales'])
    return ranked


all_rank = rank(moves)
oct_rank = rank([m for m in moves if dt(m['created_at']).strftime('%Y-%m') == '2026-10'])
exp['top_product'] = [all_rank[0][0], all_rank[0][1]['sales'], all_rank[0][1]['qty']]
exp['top_oct'] = [oct_rank[0][0], oct_rank[0][1]['sales'], oct_rank[0][1]['qty']]


# ---------------- 订单管理页 ----------------
tot = dict(orders=0, moves=0, qty=0, sales=0.0, cost=0.0, other=0.0, net=0.0)
for no, r in oagg.items():
    tot['orders'] += 1
    for k in ('moves', 'qty', 'sales', 'cost', 'net'):
        tot[k] += r[k]
    tot['other'] += r['other']

by_sales = sorted(oagg.items(), key=lambda kv: -kv[1]['sales'])
by_net = sorted(oagg.items(), key=lambda kv: -kv[1]['net'])

exp['orders']['total'] = tot
exp['orders']['top_sales'] = [pick(kv[0]) for kv in by_sales[:3]]
exp['orders']['top_net'] = pick(by_net[0][0])
exp['order_1064'] = {
    'moves': oagg['MOCK-TK2026101064']['moves'],
    'qty': oagg['MOCK-TK2026101064']['qty'],
    'sales': oagg['MOCK-TK2026101064']['sales'],
    'cost': oagg['MOCK-TK2026101064']['cost'],
    'other_cost': oagg['MOCK-TK2026101064']['other'],
    'net': oagg['MOCK-TK2026101064']['net'],
    'margin': oagg['MOCK-TK2026101064']['margin'],
}
exp['orders']['o1064'] = pick('MOCK-TK2026101064')
exp['orders']['star'] = pick('MOCK-TK2026091946')
# newest 与 with_other / no_buyer / search 沿用上一版（与币种无关）
exp['orders']['newest'] = dict(exp['orders']['newest'], **{
    'sales': oagg[exp['orders']['newest']['no']]['sales'],
    'cost': oagg[exp['orders']['newest']['no']]['cost'],
    'other': oagg[exp['orders']['newest']['no']]['other'],
    'net': oagg[exp['orders']['newest']['no']]['net'],
    'margin': oagg[exp['orders']['newest']['no']]['margin'],
})

exp['rate'] = RATE

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(exp, f, ensure_ascii=False, indent=2)

print('汇率 %.2f · 订单 %d 个 · 订单金额合计 ¥%.2f' % (RATE, tot['orders'], tot['sales']))
print('订单 MOCK-TK2026101064: 金额 ¥%.2f / 成本 ¥%.2f / 净利 ¥%.2f' % (
    exp['order_1064']['sales'], exp['order_1064']['cost'], exp['order_1064']['net']))
print('报表 2026-10: 销售额 ¥%.2f / %d 件 / %d 笔 / 毛利 ¥%.2f' % (
    exp['report']['month202610']['sales'], exp['report']['month202610']['qty'],
    exp['report']['month202610']['orders'], exp['report']['month202610']['profit']))
print('报表 2026 年: 销售额 ¥%.2f / 毛利 ¥%.2f' % (
    exp['report']['year2026']['sales'], exp['report']['year2026']['profit']))
