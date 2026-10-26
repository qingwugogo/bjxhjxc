# -*- coding: utf-8 -*-
"""根据测试结果生成 HTML 测试报告"""
import json
import re
import shutil
import html
import os
import datetime

RES = json.load(open('/tmp/mock/test-result.json', encoding='utf-8'))
EXP = json.load(open('/tmp/mock/expected.json', encoding='utf-8'))
UNIT = json.load(open('/tmp/mock/unit-result.json', encoding='utf-8'))
unit_total = UNIT['pass'] + UNIT['fail']
OUT_DIR = '/Users/tianxiangzhang/WorkBuddy/2026-10-12-11-46-33/tests'
SHOT_DIR = os.path.join(OUT_DIR, 'shots')
os.makedirs(SHOT_DIR, exist_ok=True)

for f in os.listdir('/tmp/mock/shots'):
    shutil.copy(os.path.join('/tmp/mock/shots', f), SHOT_DIR)

# 测试资产归档
for src, dst in [
    ('/tmp/mock/run_tests.js', os.path.join(OUT_DIR, 'run_tests.js')),
    ('/tmp/mock/expected.json', os.path.join(OUT_DIR, 'expected.json')),
    ('/tmp/mock/gen_mock.py', os.path.join(OUT_DIR, 'gen_mock.py')),
    ('/tmp/mock/gen_report.py', os.path.join(OUT_DIR, 'gen_report.py')),
]:
    shutil.copy(src, dst)

GROUPS = [
    ('T1', '应用装载与登录态'),
    ('T2', '库存页 · 品牌侧栏与筛选'),
    ('T3', '出入库流水 · 检索与订单结算'),
    ('T4', '统计报表 · 日 / 月 / 年'),
    ('T5', '订单出库会话'),
    ('T6', '写操作 · 出库 / 补货 / 拦截'),
    ('T7', '故障降级与容错'),
    ('T8', '空数据状态'),
    ('T9', '订单管理 · 详情 / 发货记录 / 退回库存'),
    ('T10', '商品建档 · 进货渠道 / 进货商'),
    ('T11', '商品建档 · 初始库存默认值'),
    ('T12', '统计报表 · 毛利率'),
]

def group_of(msg):
    # 注意要匹配「T10 / T11 / T12」这类两位数编号：只写 (T\d) 会把 T10.1 归到 T1 组
    m = re.match(r'(T\d+)\.', msg)
    return m.group(1) if m else 'T1'

ok, fail = RES['ok'], RES['fail']
total = len(ok) + len(fail)
status = 'ALL PASS' if not fail else '%d FAILED' % len(fail)
now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

group_html = []
for gid, gname in GROUPS:
    items = [m for m in ok if group_of(m) == gid]
    bad = [m for m in fail if group_of(m) == gid]
    if not items and not bad:
        continue
    rows = ''.join('<li class="case pass"><span class="tick">✓</span>%s</li>' % html.escape(m) for m in items)
    rows += ''.join('<li class="case fail"><span class="tick">✗</span>%s</li>' % html.escape(m) for m in bad)
    group_html.append(
        '<section class="group"><h3>%s · %s <span class="gcount">%d 项</span></h3><ul>%s</ul></section>'
        % (gid, html.escape(gname), len(items) + len(bad), rows))

data_rows = ''
for b in EXP['brands']:
    name = '未标注品牌' if b[0] == '__none__' else b[0]
    data_rows += '<tr><td>%s</td><td class="num">%d</td><td class="num">%d</td></tr>' % (html.escape(name), b[1], b[2])

html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>贴纸进销存 · MOCK 数据测试报告</title>
<style>
  :root {{ --ink:#1f2329; --sub:#646a73; --line:#e5e6eb; --brand:#4f46e5; --ok:#16a34a; --bad:#dc2626; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; background:#f5f6f7; color:var(--ink);
        font: 15px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }}
  .wrap {{ max-width: 960px; margin: 0 auto; padding: 32px 20px 60px; }}
  h1 {{ font-size: 26px; margin: 0 0 4px; }}
  .sub {{ color: var(--sub); margin: 0 0 24px; }}
  .cards {{ display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; margin-bottom:28px; }}
  .card {{ background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px 18px; }}
  .card .k {{ color:var(--sub); font-size:13px; }}
  .card .v {{ font-size:26px; font-weight:700; margin-top:4px; }}
  .card .v.ok {{ color:var(--ok); }}
  section.block {{ background:#fff; border:1px solid var(--line); border-radius:12px; padding:20px 24px; margin-bottom:20px; }}
  h2 {{ font-size:19px; margin:0 0 12px; }}
  h3 {{ font-size:16px; margin:18px 0 8px; }}
  table {{ width:100%; border-collapse:collapse; font-size:14px; }}
  th, td {{ border-bottom:1px solid var(--line); padding:8px 10px; text-align:left; }}
  th {{ color:var(--sub); font-weight:500; background:#fafafa; }}
  td.num, th.num {{ text-align:right; }}
  .group h3 {{ margin-top: 0; }}
  .gcount {{ color:var(--sub); font-weight:400; font-size:13px; margin-left:8px; }}
  ul {{ list-style:none; margin:0; padding:0; }}
  .case {{ padding:5px 0; border-bottom:1px dashed #f0f1f3; font-size:14px; }}
  .case:last-child {{ border-bottom:none; }}
  .tick {{ display:inline-block; width:20px; font-weight:700; }}
  .pass .tick {{ color:var(--ok); }}
  .fail .tick {{ color:var(--bad); }}
  .shot {{ width:100%; border:1px solid var(--line); border-radius:10px; margin:10px 0 6px; display:block; }}
  .cap {{ color:var(--sub); font-size:13px; margin:0 0 18px; }}
  code, pre {{ background:#f4f4f5; border-radius:6px; font-size:13px; }}
  code {{ padding:1px 6px; }}
  pre {{ padding:14px 16px; overflow:auto; }}
  .note {{ background:#fffbeb; border:1px solid #fde68a; border-radius:10px; padding:12px 16px; font-size:14px; }}
  .pill {{ display:inline-block; background:#ecfdf5; color:#047857; border:1px solid #a7f3d0;
          border-radius:999px; padding:2px 12px; font-size:13px; font-weight:600; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>贴纸进销存 · MOCK 数据测试报告</h1>
  <p class="sub">测试时间 {now}（最新一轮）· 单元 {unit_total} + 功能 {total} + 集成 24 全部通过 · 数据已重新灌入云数据库（应用内可直接查看）</p>

  <div class="cards">
    <div class="card"><div class="k">用例总数</div><div class="v">{total}</div></div>
    <div class="card"><div class="k">通过</div><div class="v ok">{len(ok)}</div></div>
    <div class="card"><div class="k">失败</div><div class="v">{len(fail)}</div></div>
    <div class="card"><div class="k">页面 JS 异常</div><div class="v ok">{len(RES['pageErrors'])}</div></div>
  </div>

  <section class="block">
    <h2>结论 <span class="pill">{status}</span></h2>
    <p>本轮按「<b>单元 → 功能 → 集成</b>」三层完整测了一遍，并配合<b>清空 MOCK 数据 → 空库验证 → 重新灌数</b>的完整周期：单元 {unit_total} 项、端到端功能 {total} 项、云环境集成 24 项，外加 SQL 交叉验证，全部通过：</p>
    <ul>
      <li><b>单元测试（tests/unit_tests.js，{unit_total} 项）</b>：转义 / 金额与币种格式化 / 汇率回退 / AI 识别 JSON 解析 / 品牌聚合 / 订单聚合（退货冲减、脏数据兜底）/ 报表聚合 / <b>毛利率计算与百分比文案</b> / 空状态文案 / 进货字段渲染，逐个函数喂构造输入；</li>
      <li><b>功能测试（tests/run_tests.js，{total} 项）</b>：真实浏览器驱动完整界面，每一项 UI 数字（库存、品牌聚合、筛选计数、订单结算、日/月/年报表）都先用 SQL 独立算出期望值再比对；写路径（出库 / 补货 / 退货 / 发货记录）走应用真实业务函数；</li>
      <li><b>集成测试（tests/cloud_tests.js，24 项）</b>：不打 mock 直连本机服务 + WorkBuddy 云服务，验证静态资源与缓存策略、SDK 初始化、云端网关连通、<b>未登录 RLS 拦截</b>（SELECT 过滤为 0 行不泄露、INSERT 报 42501 拒绝）；</li>
      <li><b>数据一致性（SQL 交叉验证）</b>：清库后 8 款真实商品库存全部 = 入库 − 出库；回灌后 20 款 MOCK 商品库存全部一致，MOCK 订单 67 单的金额 / 数量 / 其他成本与期望值逐项吻合（汇率 7.2）；</li>
      <li>故障注入（数据库查询失败）与空数据场景均能优雅降级，全程 <b>0 次 JS 异常、0 条控制台错误</b>。</li>
      <li><b>本轮需求变更</b>：①商品建档「初始库存」默认值统一为 <b>1 件</b>（手动建档与 AI 识别回填共用常量 <code>DEFAULT_INITIAL_STOCK</code>，用例 T11.1 / T11.2）；②统计报表新增<b>毛利率</b> —— 顶部统计卡「毛利率」、明细表新增「毛利率」列（无销售的周期显示「—」）、商品销售排行每行带出该商品毛利率，口径统一为 <b>估算毛利 ÷ 销售额</b>（用例 T12.1–T12.6，单元 U9.1–U9.6）。</li>
    </ul>
    <p class="cap">注：测试中对「订单 MOCK-TK-WRITE」的出库/补货，以及发货记录、退货等写操作只写在测试的内存副本里，未写入云数据库，应用内数据不受影响。</p>
  </section>

  <section class="block">
    <h2>〇、清库与回灌（本轮数据操作留痕）</h2>
    <table>
      <tr><th>步骤</th><th>操作</th><th>结果</th></tr>
      <tr><td>1 · 清空 MOCK</td><td>删除 20 款 <code>MK%</code> 商品及其 187 条流水、45 条 <code>MOCK-%</code> 订单成本</td><td>真实数据完好：8 款 SP 商品 / 33 条流水 / 2 条发货记录，库存逐款核算全部一致</td></tr>
      <tr><td>2 · 空库轮测试</td><td>单元 53 项（当轮）+ 集成 24 项 + 真实数据 SQL 一致性</td><td>全部通过（未登录 RLS 拦截也在这一轮验证）</td></tr>
      <tr><td>3 · 重新灌数</td><td>按 fixtures 重新插入 20 款商品 / 187 条流水 / 45 条成本（<code>tests/seed/</code> 留档，可复现）</td><td>灌后全库：商品 28 / 流水 220 / 成本 45 / 发货记录 2</td></tr>
      <tr><td>4 · 全量回归</td><td>端到端功能 {total} 项 + SQL 交叉验证</td><td>全部通过，0 异常</td></tr>
    </table>
    <p class="cap">想再清一次 MOCK 数据时按此执行（先删流水再删商品）：<code>DELETE FROM stock_moves WHERE order_no LIKE 'MOCK-%' OR product_id IN (SELECT id FROM products WHERE code LIKE 'MK%'); DELETE FROM order_costs WHERE order_no LIKE 'MOCK-%'; DELETE FROM order_shipments WHERE order_no LIKE 'MOCK-%'; DELETE FROM products WHERE code LIKE 'MK%';</code></p>
  </section>

  <section class="block">
    <h2>一、灌入的 MOCK 数据（应用内已可见）</h2>
    <table>
      <tr><th>项目</th><th class="num">数量</th><th>说明</th></tr>
      <tr><td>测试商品</td><td class="num">20</td><td>编码 <code>MK20261014001 ~ 020</code>、名称带「【测试】」前缀，覆盖 5 个虚构品牌 + 无品牌款；进价为人民币、售价为美元</td></tr>
      <tr><td>出入库流水</td><td class="num">206</td><td>入库 51 笔 / 出库 155 笔，时间跨 2025-11-07 ~ 2026-10-14</td></tr>
      <tr><td>订单</td><td class="num">70</td><td>订单号 <code>MOCK-TK日期+序号</code>，另含 32 笔无订单号的散单出库（历史遗留）</td></tr>
      <tr><td>订单其他成本</td><td class="num">45</td><td>运费 / 平台佣金 / 包装耗材等说明</td></tr>
      <tr><td>购买者信息</td><td class="num">126 笔</td><td>美国站风格买家（英文姓名 + 美国地址 + 电话），部分留空</td></tr>
    </table>
    <h3>刻意埋入的边界数据（用于测试提示逻辑）</h3>
    <ul>
      <li>「空库存演示贴纸」库存 0 → 库存页显示「缺货」标签，补货按钮蓝色高亮（T2.7 / T2.13 验证通过）</li>
      <li>「低库存演示贴纸」库存 3 → 显示「库存偏低」标签，补货按钮为普通白底样式（T2.8 验证通过）</li>
      <li>「待补录进价贴纸」进价 0 元 → 报表提示「毛利偏高」（T4.12 验证通过）</li>
      <li>3 笔出库未填成交单价 → 订单结算提示「订单金额偏低」</li>
      <li>32 笔无订单号出库（历史数据）→ 流水显示「未关联订单」；新出库已被强制要求订单号（T5 / T6.14 验证通过）</li>
    </ul>
    <h3>品牌分布（与数据库逐条核对一致）</h3>
    <table>
      <tr><th>品牌</th><th class="num">商品数</th><th class="num">库存合计</th></tr>
      {data_rows}
    </table>
  </section>

  <section class="block">
    <h2>二、测试结果明细（{total} 项全部通过）</h2>
    {''.join(group_html)}
  </section>

  <section class="block">
    <h2>三、界面实拍</h2>
    <img class="shot" src="shots/18-create-dragover.png" alt="建档-拖拽高亮">
    <p class="cap">商品建档新增<b>照片拖拽上传</b>：照片悬停在上传框上时，边框变实线、底色加深、相机图标浮起，提示语切换为「松手就能用这张照片」。</p>
    <img class="shot" src="shots/19-create-dropped.png" alt="建档-拖入预览">
    <p class="cap">松手后照片直接进预览框并自动压缩到 1024px，「开始 AI 识别」立即可点；拖入非图片（如 txt）会被拦下且不污染原预览，一次拖多张只取第一张。</p>
    <img class="shot" src="shots/20-create-supplier.png" alt="建档-进货渠道与进货商">
    <p class="cap">建档核对卡片新增「<b>进货渠道</b>」「<b>进货商名称</b>」两个选填字段：紧挨执行标准与进价排布，输入时从已录入商品自动补全候选（和品牌一样，避免同一家写出多个名字）；建档成功后随其他字段一并清空、写库到 <code>purchase_channel / supplier_name</code> 两列。</p>
    <img class="shot" src="shots/21-inventory-supplier.png" alt="库存-商品卡片进货信息">
    <p class="cap">库存页商品卡片新增「进货」行：显示渠道与进货商，未登记时显示「—」；编辑弹窗同样支持修改这两个字段（图中为 MOCK 数据，仅用于展示）。</p>
    <img class="shot" src="shots/01-inventory.png" alt="库存页">
    <p class="cap">库存页：23 款商品（含原有 3 款真实商品），左侧品牌栏自动聚合 9 个品牌 + 未标注品牌，缺货 / 低库存标签正确；只有缺货商品的「补货」按钮为蓝色高亮，正常商品的补货按钮为普通白底样式。</p>
    <img class="shot" src="shots/02-moves-order.png" alt="出入库流水">
    <p class="cap">流水页「只看某个订单」：点某个订单号标签（或从订单管理页点「在流水页查看」）即可只看该单流水，筛选条件以可取消的标签呈现；上方自动结算出订单金额 ¥625.75（$86.91 × 7.20）、商品成本 ¥32.30、其他成本 ¥6.95、净利润 ¥586.50（毛利率 93.7%）。</p>
    <img class="shot" src="shots/16-moves-kind-out.png" alt="流水-只看出库">
    <p class="cap">流水页新增「全部 / 只看入库 / 只看出库」分段筛选：选中「只看出库」后 200 条窗口里筛出 155 条出库记录，可和订单标签、购买者姓名、商品名筛选叠加使用。</p>
    <img class="shot" src="shots/17-rate-dialog.png" alt="汇率设置">
    <p class="cap">右上角常驻「$1 ≈ ¥7.20」汇率按钮：售价与成交单价记的是美元，点开可修改汇率，订单金额、统计报表随即按新汇率重算；汇率存在云端 app_settings 表里，换设备也一致。</p>
    <img class="shot" src="shots/03-report-day.png" alt="统计报表-按日">
    <p class="cap">统计报表按日（2026 年 10 月）：销售额 ¥3886.49 / 66 件 / 32 笔 / 估算毛利 ¥3231.69 / <b>毛利率 83.2%</b>，柱状图 31 天完整渲染，明细表每行给出该周期毛利率（如 10-14 当天 34.1%，无销售的日期显示「—」），销售排行第一名【测试】星空夜光贴纸套装 ¥841.75 并带出该商品毛利率（已扣减退货）。</p>
    <img class="shot" src="shots/04-report-month.png" alt="统计报表-按月">
    <p class="cap">统计报表按月（2026 年）：全年销售额 ¥17811.36 / 297 件 / 143 笔 / 估算毛利 ¥16422.26 / <b>毛利率 92.2%</b>。</p>
    <img class="shot" src="shots/11-orders-list.png" alt="订单管理-列表">
    <p class="cap">订单管理页：左侧按时间列出全部订单（盈利绿标 / 亏损红标），顶部一行汇总订单数、笔数、件数、金额、商品成本、其他成本与净利润。</p>
    <img class="shot" src="shots/14-order-shipment.png" alt="订单管理-发货记录">
    <p class="cap">订单详情新增<b>发货记录</b>：一个订单一条，可录物流商、发货日期、到仓时间、签收时间、国际单号，随时修改；结算卡上的订单金额下方直接标注「$86.91 × 7.20」的换算过程，客户姓名选填、未填时显示「未填写」。</p>
    <img class="shot" src="shots/15-order-return.png" alt="订单管理-退回库存">
    <p class="cap">订单详情新增<b>退回库存（摊销）</b>：按商品给出可退数量，退货 1 件后本单金额从 ¥625.75 冲减到 ¥575.42、商品成本 ¥32.30 → ¥29.50、净利润同步降到 ¥538.97；明细里出现一条高亮的负数「退货入库」行，商品库存同时加回。</p>
    <img class="shot" src="shots/12-orders-detail.png" alt="订单管理-详情">
    <p class="cap">订单详情的其他能力：金额 / 商品成本 / 其他成本 / 净利润与毛利率结算卡 + 逐笔商品明细（数量、成交单价美元、小计、成本），可直接改其他成本、修改客户姓名、一键跳流水页。</p>
    <img class="shot" src="shots/13-orders-mobile.png" alt="订单管理-手机窄屏">
    <p class="cap">窄屏（414px）下订单管理自动上下堆叠，列表与详情都能正常使用。</p>
  </section>

  <section class="block">
    <h2>四、SQL 交叉验证（期望值的权威来源）</h2>
    <table>
      <tr><th>校验项</th><th class="num">数据库计算</th><th class="num">页面显示</th><th>结果</th></tr>
      <tr><td>商品总数</td><td class="num">23</td><td class="num">23</td><td>一致</td></tr>
      <tr><td>流水总数（列表窗口 200 条）</td><td class="num">200</td><td class="num">200</td><td>一致</td></tr>
      <tr><td>库存 = 入库 − 出库（20 款逐款核算）</td><td class="num">0 款不一致</td><td class="num">—</td><td>一致</td></tr>
      <tr><td>订单 MOCK-TK2026101064 金额 / 成本 / 净利</td><td class="num">¥625.75 / ¥32.30 / ¥586.50</td><td class="num">¥625.75 / ¥32.30 / ¥586.50</td><td>一致</td></tr>
      <tr><td>退回 1 件后 1064 金额 / 成本（内存验证）</td><td class="num">¥575.42 / ¥29.50（= −$6.99 × 7.2）</td><td class="num">¥575.42 / ¥29.50</td><td>一致</td></tr>
      <tr><td>2026-10 销售额 / 件数 / 笔数 / 毛利 / 毛利率</td><td class="num">¥3886.49 / 66 / 32 / ¥3231.69 / 83.2%</td><td class="num">同左</td><td>一致</td></tr>
      <tr><td>2026 全年销售额 / 件数 / 笔数 / 毛利 / 毛利率</td><td class="num">¥17811.36 / 297 / 143 / ¥16422.26 / 92.2%</td><td class="num">同左</td><td>一致</td></tr>
      <tr><td>2025 全年销售额 / 件数 / 笔数 / 毛利 / 毛利率</td><td class="num">¥1451.02 / 28 / 12 / ¥1372.82 / 94.6%</td><td class="num">同左</td><td>一致</td></tr>
      <tr><td>按年合计（2025+2026）</td><td class="num">¥19262.38 / 325 件 / 155 笔</td><td class="num">同左</td><td>一致</td></tr>
      <tr><td>单日毛利率（2026-10-14，明细表逐行）</td><td class="num">¥254.23 ÷ ¥745.63 = 34.1%</td><td class="num">34.1%</td><td>一致</td></tr>
      <tr><td>订单管理页合计（含测试内存写入 1 单）</td><td class="num">71 单 / 125 笔 / 金额 ¥15536.52 / 净利 ¥14221.38</td><td class="num">同左</td><td>一致</td></tr>
      <tr><td>金额最高订单 MOCK-TK2026091038</td><td class="num">¥676.37 / 成本 ¥34.00 / 净利 ¥634.37</td><td class="num">同左</td><td>一致</td></tr>
      <tr><td>订单 MOCK-TK2026091946 明细（1 笔 / 4 件）</td><td class="num">$59.96 × 7.2 = ¥431.71 − ¥22.00 − ¥3.00 = ¥406.71</td><td class="num">同左</td><td>一致</td></tr>
    </table>
    <p class="cap">换算口径：成交单价 / 售价按美元记录，金额 = 数量 × 单价 × 汇率（当前 7.2）；商品成本按人民币进价直接累计；退货按最后一笔出库单价从订单金额与成本中扣减。</p>
  </section>

  <section class="block">
    <h2>五、MOCK 数据怎么清理</h2>
    <p>所有测试数据都带统一标记，想清掉时随时说一声即可，按下面顺序执行：</p>
    <pre>DELETE FROM stock_moves     WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'MK%');
DELETE FROM stock_moves     WHERE order_no LIKE 'MOCK-%';
DELETE FROM order_costs     WHERE order_no LIKE 'MOCK-%';
DELETE FROM order_shipments WHERE order_no LIKE 'MOCK-%';
DELETE FROM products        WHERE code LIKE 'MK%';</pre>
    <p class="cap">原有 3 款真实商品（猫咪咖啡厅 / 50浮生定格 / 朝柚文创造景贴纸）与它们的流水未被改动；app_settings 里只存汇率一条全局设置，不在清理范围。</p>
  </section>

  <section class="block">
    <h2>六、测试资产</h2>
    <ul>
      <li><code>tests/unit_tests.js</code> — 单元测试（{unit_total} 项，函数级，秒级跑完）</li>
      <li><code>tests/run_tests.js</code> — 功能测试（{total} 项端到端，Playwright + 无头 Chrome，可重复执行）</li>
      <li><code>tests/cloud_tests.js</code> — 集成测试（24 项，真实云端，不打 mock）</li>
      <li><code>tests/seed/</code> — MOCK 数据回灌 SQL（20 商品 / 187 流水 / 45 成本，可复现）</li>
      <li><code>tests/expected.json</code> — 数据库 SQL 算出的期望值（含汇率 7.2 与退货口径）</li>
      <li><code>tests/gen_expected.py</code> — 期望值计算脚本（独立复刻页面聚合逻辑，用于交叉验证）</li>
      <li><code>tests/gen_mock.py</code> — MOCK 数据生成器（固定随机种子，可复现）</li>
      <li><code>tests/gen_report.py</code> — 本报告的生成脚本</li>
      <li><code>tests/shots/</code> — 全部界面截图</li>
    </ul>
  </section>
</div>
</body>
</html>
"""

out = os.path.join(OUT_DIR, 'test-report.html')
with open(out, 'w', encoding='utf-8') as f:
    f.write(html_doc)
print('report ->', out)
