# -*- coding: utf-8 -*-
"""
贴纸进销存 · MOCK 测试数据生成器
用法:
  python3 gen_mock.py products              -> 打印 /tmp/mock/01_products.sql
  python3 gen_mock.py moves <codemap.json>  -> 打印流水 + 订单成本 SQL
  python3 gen_mock.py plan                  -> 打印数据设计摘要
"""
import json
import random
import sys
import datetime as dt
import os

OWNER = "2110255491077648384"
NOTE = "MOCK 测试数据 · 可安全删除"
OUT = "/tmp/mock"
R = random.Random(20261014)

# code, 名称, 品牌, 产地, 材质, 规格, 执行标准, 进价, 售价
PRODUCTS = [
    ("001", "森系植物手帐贴纸包", "纸间集", "浙江义乌", "铜版纸+哑膜", "12 张/包 · 100×150mm", "GB 21027-2020", 2.80, 6.99),
    ("002", "可爱猫咪表情贴纸卷", "纸间集", "浙江义乌", "和纸", "6 米/卷 · 宽 15mm", "GB 21027-2020", 3.20, 7.99),
    ("003", "复古邮票风装饰贴纸", "纸间集", "广东东莞", "铜版纸+亮膜", "30 枚/包 · 40×50mm", "GB/T 2792-2014", 1.90, 4.99),
    ("004", "星空夜光贴纸套装", "MoonBerry", "广东深圳", "夜光 PET", "20 枚/套 · 60×60mm", "GB 21027-2020", 4.50, 12.99),
    ("005", "莫兰迪色系标签贴纸", "MoonBerry", "广东深圳", "书写纸", "8 张/包 · 25×40mm", "GB 21027-2020", 2.60, 6.50),
    ("006", "樱花季节限定贴纸", "嘟嘟贴纸屋", "浙江温州", "和纸", "15 枚/包 · 55×70mm", "GB/T 2792-2014", 3.00, 8.99),
    ("007", "奶茶日常手绘贴纸", "嘟嘟贴纸屋", "浙江温州", "铜版纸+哑膜", "18 枚/包 · 50×60mm", "GB 21027-2020", 2.20, 5.99),
    ("008", "Y2K 镭射闪光贴纸", "Yuki Studio", "广东东莞", "镭射膜+PET", "12 枚/包 · 65×65mm", "GB 21027-2020", 5.50, 14.99),
    ("009", "韩系简约字母贴纸", "Yuki Studio", "广东东莞", "透明 PVC", "4 张/包 · 90×120mm", "Q/YKS 001-2024", 1.60, 3.99),
    ("010", "万圣节南瓜贴纸", "星尘手帐", "江苏苏州", "铜版纸+亮膜", "24 枚/包 · 45×45mm", "GB 21027-2020", 2.40, 6.99),
    ("011", "圣诞麋鹿烫金贴纸", "星尘手帐", "江苏苏州", "烫金纸", "10 枚/包 · 70×70mm", "GB 21027-2020", 6.00, 16.99),
    ("012", "美式复古公路贴纸", "", "浙江义乌", "防水 PET", "50 枚/包 · 30×40mm", "GB/T 2792-2014", 3.80, 9.99),
    ("013", "透明水晶滴胶贴纸", "", "广东深圳", "环氧滴胶+PVC", "6 枚/包 · 55×55mm", "Q/SZJ 012-2023", 4.20, 10.99),
    ("014", "手帐胶带贴纸组合装", "纸间集", "浙江义乌", "和纸+铜版纸", "6 卷/盒 · 宽 8-15mm", "GB 21027-2020", 8.00, 19.99),
    ("015", "教师奖励贴纸 500 贴", "星尘手帐", "江苏苏州", "铜版纸", "500 枚/卷 · 直径 25mm", "GB 21027-2020", 7.50, 15.99),
    ("016", "防水手机壳装饰贴纸", "嘟嘟贴纸屋", "浙江温州", "防水 PET", "40 枚/包 · 35×50mm", "GB/T 2792-2014", 2.00, 5.50),
    ("017", "原创插画角色贴纸", "MoonBerry", "广东深圳", "铜版纸+哑膜", "20 枚/包 · 60×80mm", "GB 21027-2020", 3.60, 9.50),
    ("018", "空库存演示贴纸", "纸间集", "浙江义乌", "铜版纸", "10 枚/包 · 50×50mm", "GB 21027-2020", 1.50, 3.99),
    ("019", "待补录进价贴纸", "星尘手帐", "江苏苏州", "铜版纸+哑膜", "12 枚/包 · 55×75mm", "GB 21027-2020", 0.0, 7.99),
    ("020", "低库存演示贴纸", "嘟嘟贴纸屋", "浙江温州", "和纸", "16 枚/包 · 50×60mm", "GB 21027-2020", 2.90, 7.50),
]
CODE_PREFIX = "MK20261014"

BUYERS = [
    ("Jessica Miller", "+1 614-555-0142", "1420 Elm St, Columbus, OH 43215", "TikTok Shop 美国站"),
    ("Daniel Reyes", "+1 512-555-0193", "88 Maple Ave, Austin, TX 78701", "买家留言：请尽快发货"),
    ("Emily Chen", "+1 415-555-0117", "2330 Pine St, San Francisco, CA 94115", ""),
    ("Michael Turner", "+1 305-555-0164", "765 Ocean Dr, Miami, FL 33139", "复购客户"),
    ("Sophia Lopez", "+1 206-555-0188", "314 Pine Ave, Seattle, WA 98101", ""),
    ("Ethan Walker", "+1 312-555-0129", "902 W Madison St, Chicago, IL 60607", "要求礼品包装"),
    ("Olivia Parker", "+1 617-555-0155", "45 Beacon St, Boston, MA 02108", ""),
    ("Noah Bennett", "+1 702-555-0133", "6120 Las Vegas Blvd, NV 89119", ""),
    ("Ava Kim", "+1 213-555-0176", "1180 S Hope St, Los Angeles, CA 90015", ""),
    ("Liam Stewart", "+1 404-555-0148", "650 Peachtree St, Atlanta, GA 30308", "批发意向"),
    ("Mia Gonzalez", "+1 720-555-0111", "1900 Broadway, Denver, CO 80202", ""),
    ("Lucas Hughes", "+1 615-555-0179", "401 Commerce St, Nashville, TN 37219", ""),
    ("Emma Diaz", "+1 602-555-0122", "2201 N Central Ave, Phoenix, AZ 85004", ""),
    ("James Foster", "+1 971-555-0197", "1300 SW 5th Ave, Portland, OR 97201", ""),
    ("Isabella Nguyen", "+1 408-555-0108", "288 S 2nd St, San Jose, CA 95113", "老客户，第 3 次下单"),
    ("Benjamin Ortiz", "+1 919-555-0184", "150 Fayetteville St, Raleigh, NC 27601", ""),
    ("Charlotte Webb", "+1 216-555-0136", "1201 Euclid Ave, Cleveland, OH 44115", ""),
    ("Henry Yamada", "+1 808-555-0163", "307 Lewers St, Honolulu, HI 96815", ""),
    ("Amelia Brooks", "+1 314-555-0191", "800 Market St, St. Louis, MO 63101", ""),
    ("Jack Verhoeven", "+1 503-555-0157", "1000 SW Broadway, Portland, OR 97205", ""),
]


def iso(d: dt.datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:00+08:00")


def q(s) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def code_of(idx: str) -> str:
    return CODE_PREFIX + idx


# ---------------- 时间线 ----------------
START = dt.datetime(2025, 11, 5, 10, 0, 0)
NOW = dt.datetime(2026, 10, 14, 15, 30, 0)


def build_plan():
    """返回 products(list of dict), moves(list of dict)"""
    prods = []
    for idx, name, brand, origin, material, spec, std, cost, sale in PRODUCTS:
        prods.append({
            "code": code_of(idx), "idx": idx, "name": "【测试】" + name, "brand": brand,
            "origin": origin, "material": material, "spec": spec, "standard": std,
            "cost": cost, "sale": sale,
        })

    moves = []          # {code, type, qty, price, at, order, buyer}
    stock = {p["code"]: 0 for p in prods}
    last_in = {}
    last_out = {}

    def add_in(code, qty, at, price=0):
        moves.append({"code": code, "type": "in", "qty": qty, "price": price, "at": at,
                      "order": None, "buyer": None})
        stock[code] += qty
        last_in[code] = at

    def add_out(code, qty, price, at, order, buyer):
        moves.append({"code": code, "type": "out", "qty": qty, "price": price, "at": at,
                      "order": order, "buyer": buyer})
        stock[code] -= qty
        last_out[code] = at

    # 1) 商品建档时间（早于所有流水）
    for p in prods:
        p["created_at"] = START + dt.timedelta(days=R.randint(0, 12),
                                               hours=R.randint(0, 9),
                                               minutes=R.randint(0, 59))

    # 2) 订单：先稀疏后密集
    orders = []
    t = dt.datetime(2025, 11, 20, 12, 0, 0)
    while t < dt.datetime(2026, 9, 1):
        orders.append(t)
        t = t + dt.timedelta(days=R.randint(7, 14), hours=R.randint(0, 8))
    t = dt.datetime(2026, 9, 1, 12, 0, 0)
    while t < NOW:
        orders.append(t)
        t = t + dt.timedelta(days=R.choice([1, 1, 2]), hours=R.randint(-6, 8))
    orders = [o for o in orders if o < NOW - dt.timedelta(hours=2)]

    weight_pool = []
    for i, p in enumerate(prods[:16]):        # 前 16 个是主销
        weight_pool += [p["code"]] * (16 - i)
    weight_pool += [p["code"] for p in prods[16:]]

    order_meta = []      # (order_no, at, lines)
    for i, o in enumerate(orders, start=1):
        no = "MOCK-TK" + o.strftime("%Y%m%d") + "%02d" % (i % 100)
        lines = []
        for _ in range(R.choice([1, 1, 2, 2, 3])):
            code = R.choice(weight_pool)
            qty = R.choice([1, 1, 2, 2, 3, 4])
            price = None
            lines.append([code, qty, price])
        order_meta.append([no, o, lines])

    # 4) 逐单出库
    for no, o, lines in order_meta:
        for line in lines:
            code, qty = line[0], line[1]
            p = next(x for x in prods if x["code"] == code)
            # 折扣：约 18% 的行按 8 折 / 9 折出售
            pr = p["sale"]
            r = R.random()
            if r < 0.10:
                pr = round(p["sale"] * 0.8, 2)
            elif r < 0.18:
                pr = round(p["sale"] * 0.9, 2)
            if code == code_of("019") and R.random() < 0.30:
                pr = 0                      # 边界数据：出库未填单价
            at = o + dt.timedelta(minutes=R.randint(0, 120))
            add_out(code, qty, pr, at, no, True)
            line[2] = pr

    # 5) 散单出库（无订单号，模拟零星订单）
    t = START + dt.timedelta(days=25)
    while t < NOW - dt.timedelta(days=1):
        if R.random() < 0.30:
            code = R.choice(weight_pool)
            p = next(x for x in prods if x["code"] == code)
            add_out(code, R.choice([1, 1, 2, 3]), p["sale"],
                    t + dt.timedelta(hours=R.randint(0, 10)), None, R.random() < 0.6)
        t += dt.timedelta(days=R.randint(2, 5))

    # 6) 按需补货：出库先定，再倒推入库，保证库存永不为负、且收尾库存落在合理区间
    for i, p in enumerate(prods):
        code = p["code"]
        outs = sorted([m for m in moves if m["code"] == code and m["type"] == "out"],
                      key=lambda m: m["at"])
        if code == code_of("018"):          # 缺货演示：卖光后清空
            first_qty, extra = 0, 0
            if not outs:
                at = START + dt.timedelta(days=R.randint(60, 300), hours=R.randint(9, 21))
                add_out(code, R.randint(6, 12), p["sale"], at, None, True)
                outs = sorted([m for m in moves if m["code"] == code and m["type"] == "out"],
                              key=lambda m: m["at"])
        elif code == code_of("020"):        # 低库存演示：收尾刚好剩 3 件
            first_qty, extra = 0, 3
        elif i < 5:                          # 主销款库存略高
            first_qty, extra = R.randint(28, 48), R.randint(6, 18)
        else:
            first_qty, extra = R.randint(18, 42), R.randint(4, 18)

        first_at = p["created_at"] + dt.timedelta(hours=R.randint(2, 36))
        cur = first_qty
        if first_qty > 0:
            add_in(code, first_qty, first_at, p["cost"])
        for m in outs:
            if cur >= m["qty"]:
                cur -= m["qty"]
                continue
            need = m["qty"] - cur
            at = m["at"] - dt.timedelta(hours=R.randint(8, 72))
            if at <= first_at:
                at = first_at + dt.timedelta(hours=1)
            add_in(code, need, at, p["cost"])
            cur += need - m["qty"]
        if extra > 0:
            base_at = outs[-1]["at"] if outs else first_at
            at = min(NOW - dt.timedelta(hours=2), base_at + dt.timedelta(days=R.randint(1, 18)))
            if at <= first_at:
                at = first_at + dt.timedelta(days=1)
            add_in(code, extra, at, p["cost"])

    # 边界数据：#019（未填进价）至少留一笔未填单价的出库，供结算/报表提示逻辑测试
    o19 = [m for m in moves if m["code"] == code_of("019") and m["type"] == "out"]
    if o19:
        o19[0]["price"] = 0

    # 7) 买家信息：约 85% 的出库带买家
    bi = 0
    for m in moves:
        m["bidx"] = 0
        if m["type"] != "out" or not m["buyer"]:
            continue
        if R.random() < 0.15:
            continue
        bi += 1
        m["bidx"] = (bi % len(BUYERS)) + 1

    moves.sort(key=lambda m: m["at"])

    for p in prods:
        p["stock"] = stock[p["code"]]
        p["last_in_at"] = last_in.get(p["code"])
        p["last_out_at"] = last_out.get(p["code"])

    # 8) 订单其他成本
    costs = []
    for no, o, lines in order_meta:
        if not lines:
            continue
        sales = sum(q * pr for _, q, pr in lines)
        if o >= dt.datetime(2026, 8, 1) or R.random() < 0.20:
            oc = round(min(8.0, max(1.0, sales * R.choice([0.05, 0.08, 0.12]))), 2)
            note = R.choice(["运费 %s + 平台佣金 %s" % (round(oc * 0.6, 2), round(oc * 0.4, 2)),
                             "尾程运费", "运费 + 包装耗材", "平台佣金 + 广告分摊"])
            costs.append({"order": no, "cost": oc, "note": note})

    return prods, moves, costs, order_meta


def sql_moves_batches(moves, size=60):
    """紧凑写法：流水的商品用 code 关联 products，买家信息用编号关联买家池"""
    def val(m):
        pid = m["code"]
        pr = str(m["price"] if m["price"] is not None else 0)
        bi = m.get("bidx") or 0
        ordv = m["order"] or ""
        at = m["at"].strftime("%Y-%m-%d %H:%M+08")
        return "('%s','%s',%d,%s,%d,'%s','%s')" % (
            pid, "out" if m["type"] == "out" else "in", m["qty"], pr, bi, ordv, at)

    head = ("INSERT INTO stock_moves (owner_id, product_id, move_type, quantity, unit_price, "
            "buyer_name, buyer_phone, buyer_addr, buyer_note, order_no, created_at)\n"
            "SELECT 2110255491077648384, p.id, v.mt, v.qty::int, v.pr::numeric, "
            "b.bname, b.bphone, b.baddr, b.bnote, NULLIF(v.ord,''), v.at::timestamptz\n"
            "FROM (VALUES\n")
    tail = ("\n) AS v(code, mt, qty, pr, bi, ord, at)\n"
            "JOIN products p ON p.code = v.code\n"
            "LEFT JOIN (VALUES\n" +
            ",\n".join("(%d,%s,%s,%s,%s)" % (i + 1, q(b[0]), q(b[1]), q(b[2]),
                                             q(b[3]) if b[3] else "NULL")
                      for i, b in enumerate(BUYERS)) +
            "\n) AS b(bi, bname, bphone, baddr, bnote) ON b.bi = v.bi;")
    batches = []
    for i in range(0, len(moves), size):
        chunk = moves[i:i + size]
        batches.append(head + ",\n".join(val(m) for m in chunk) + tail)
    return batches


def sql_products(prods):
    rows = []
    for p in prods:
        stamps = [t for t in (p["last_in_at"], p["last_out_at"]) if t]
        updated = max(stamps) if stamps else p["created_at"]
        rows.append("(" + ", ".join([
            OWNER, q(p["code"]), q(p["name"]),
            q(p["brand"]) if p["brand"] else "NULL",
            q(p["origin"]), q(p["material"]), q(p["spec"]), q(p["standard"]),
            "NULL", str(p["cost"]), str(p["sale"]), str(p["stock"]),
            q(NOTE), q(iso(p["created_at"])), q(iso(updated)),
            q(iso(p["last_in_at"])) if p["last_in_at"] else "NULL",
            q(iso(p["last_out_at"])) if p["last_out_at"] else "NULL",
        ]) + ")")
    return ("INSERT INTO products (owner_id, code, name, brand, origin, material, spec, standard, "
            "image_path, cost_price, sale_price, stock, note, created_at, updated_at, "
            "last_in_at, last_out_at) VALUES\n" + ",\n".join(rows) + "\nRETURNING code, id;")


def sql_moves(moves, codemap):
    out = []
    for m in moves:
        pid = codemap[m["code"]]
        buyer = m["buyer"]
        b = ("NULL", "NULL", "NULL", "NULL")
        if buyer:
            b = (q(buyer[0]), q(buyer[1]), q(buyer[2]), q(buyer[3]) if buyer[3] else "NULL")
        out.append("(" + ", ".join([
            OWNER, str(pid), q("out" if m["type"] == "out" else "in"), str(m["qty"]),
            "NULL" if m["price"] is None else str(m["price"]),
            b[0], b[1], b[2], b[3],
            q(m["order"]) if m["order"] else "NULL",
            q(iso(m["at"])),
        ]) + ")")
    return ("INSERT INTO stock_moves (owner_id, product_id, move_type, quantity, unit_price, "
            "buyer_name, buyer_phone, buyer_addr, buyer_note, order_no, created_at) VALUES\n"
            + ",\n".join(out) + "\nRETURNING id;")


def sql_costs(costs):
    if not costs:
        return None
    rows = []
    for c in costs:
        rows.append("(" + ", ".join([OWNER, q(c["order"]), str(c["cost"]), q(c["note"]),
                                     q(iso(NOW)), q(iso(NOW))]) + ")")
    return ("INSERT INTO order_costs (owner_id, order_no, other_cost, cost_note, created_at, updated_at) "
            "VALUES\n" + ",\n".join(rows) + "\nRETURNING order_no, other_cost;")


def main():
    os.makedirs(OUT, exist_ok=True)
    mode = sys.argv[1] if len(sys.argv) > 1 else "products"
    prods, moves, costs, order_meta = build_plan()

    if mode == "products":
        print(sql_products(prods))
    elif mode == "moves":
        batches = sql_moves_batches(moves)
        for i, s in enumerate(batches, 1):
            with open(os.path.join(OUT, "02_moves_%d.sql" % i), "w", encoding="utf-8") as f:
                f.write(s)
            print("batch %d: %d bytes" % (i, len(s.encode("utf-8"))))
    elif mode == "costs":
        s = sql_costs(costs)
        with open(os.path.join(OUT, "03_costs.sql"), "w", encoding="utf-8") as f:
            f.write(s)
        print("costs sql: %d bytes" % len(s.encode("utf-8")))
    else:
        stats = []
        for p in prods:
            outs = [m for m in moves if m["code"] == p["code"] and m["type"] == "out"]
            stats.append({"code": p["code"], "stock": p["stock"], "out_moves": len(outs),
                          "out_qty": sum(m["qty"] for m in outs),
                          "in_moves": len([m for m in moves if m["code"] == p["code"] and m["type"] == "in"])})
        print(json.dumps({
            "products": len(prods), "moves": len(moves),
            "in": len([m for m in moves if m["type"] == "in"]),
            "out": len([m for m in moves if m["type"] == "out"]),
            "orders": len([o for o in order_meta if o[2]]),
            "order_costs": len(costs),
            "stock_total": sum(p["stock"] for p in prods),
            "no_order_moves": len([m for m in moves if m["type"] == "out" and not m["order"]]),
            "zero_price_moves": len([m for m in moves if m["type"] == "out" and m["price"] == 0]),
            "with_buyer": len([m for m in moves if m["type"] == "out" and m["buyer"]]),
            "date_range": [iso(moves[0]["at"]), iso(moves[-1]["at"])],
            "per_product": stats,
        }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
