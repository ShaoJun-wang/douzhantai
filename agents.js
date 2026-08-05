/* 抖战台 v2 · 真·多智能体作战内核
 * ---------------------------------------------------------------
 * 核心升级（对应赛事「技术难度」命门）：
 *  1) 4 个电商作战 Agent（选品 / 直播 / 千川 / 财务），每个含 systemPrompt + 工具列表
 *  2) Orchestrator 总指挥：一个目标自动拆给 4 个 Agent 串联执行（后一个吃前一个的结果）→ 汇总作战方案
 *  3) 工具调用 tool-use：calculator（财务实时算）、feishu_fetch（飞书表格读取，工具链演示）
 *  4) 记忆：每个 Agent 独立记忆 + 全局作战上下文（由 app.js 用 localStorage 持久化）
 *  5) 演示模式：无 Key 自动降级内置样例，评委零依赖可体验
 * 本文件只放「数据 + 纯函数」，运行时（fetch/UI/记忆）在 app.js。
 */

/* ===================== TOOLS（工具链） ===================== */
// 安全算术：只允许数字与 + - * / ( ) . 与空白，杜绝代码注入
function safeEvalMath(expr) {
  if (typeof expr !== "string") return null;
  if (!/^[\d+\-*/().\s]+$/.test(expr)) return null;
  try {
    const v = Function('"use strict";return (' + expr + ")")();
    if (typeof v !== "number" || !isFinite(v)) return null;
    return Math.round(v * 1000) / 1000;
  } catch (_) {
    return null;
  }
}

const TOOLS = {
  calculator: {
    name: "calculator",
    desc: "计算毛利率、ROI、净利等财务指标。输入算术表达式，如 (108000-45000-11000)/108000*100",
    run(arg) {
      const v = safeEvalMath(arg);
      return v === null ? "计算失败：表达式非法" : String(v);
    },
  },
  feishu_fetch: {
    name: "feishu_fetch",
    desc: "读取飞书多维表格中的竞品 / 类目参考数据（演示用示例数据，证明工具链可读外部表格）",
    run(arg) {
      return [
        "【飞书多维表格·示例数据 app_token: 示例占位-替换为你自己的飞书表token】",
        "竞品A | 客单价 ¥69 | 月销 3.2万 | 主推场景:办公室替代奶茶 | 钩子:下午三点别点奶茶",
        "竞品B | 客单价 ¥99 | 月销 1.1万 | 主推场景:大餐刮油 | 钩子:大餐不怕一杯刮油",
      ].join("\n");
    },
  },
  // 纯前端工具：解析用户粘贴的流水 / 表格文本 → 结构化 JSON（无需后端）
  extract_table: {
    name: "extract_table",
    desc: "解析用户粘贴的流水/表格文本（Markdown 表格或 | 分隔）为结构化 JSON，供财务核算等使用。",
    run(arg) {
      try {
        const lines = String(arg || "").trim().split("\n").filter((l) => l.includes("|"));
        if (!lines.length) return "未解析到表格行（请用 | 分隔列，如 GMV|120000）";
        const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        const header = rows[0];
        const data = rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] || ""])));
        return JSON.stringify(data, null, 2);
      } catch (e) {
        return "表格解析失败：" + e.message;
      }
    },
  },
  // 真实 HTTP 工具链：调用后端 /api/trend 拉取实时趋势（真实版可用，演示版自动降级）
  trend_fetch: {
    name: "trend_fetch",
    desc: "拉取实时热点/电商趋势参考（经后端 /api/trend 真实 HTTP 调用；演示版自动降级示例）。",
    async run(arg) {
      try {
        const res = await fetch("/api/trend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: arg || "电商趋势" }),
        });
        if (!res.ok) throw new Error("trend HTTP " + res.status);
        const d = await res.json();
        const list = Array.isArray(d.list) ? d.list : [];
        if (!list.length) throw new Error("空数据");
        return "【实时趋势参考】\n" + list.map((x, i) => `${i + 1}. ${x.word || x.title || x}`).join("\n");
      } catch (e) {
        return "【趋势工具·演示降级】实时接口暂不可用，返回示例：\n1. 办公室健康饮品升温\n2. 健身代餐搜索 +38%\n3. 便携小家电复购率高";
      }
    },
  },
  // 真实飞书读取：调用后端 /api/feishu（需服务端 FEISHU 凭证，演示版降级）
  feishu_real: {
    name: "feishu_real",
    desc: "读取真实飞书多维表格竞品数据（经后端 /api/feishu，需服务端凭证；演示版降级示例）。",
    async run(arg) {
      try {
        // 携带代理访问令牌（若用户在设置中填写 PROXY_ACCESS_TOKEN）
        let headers = { "Content-Type": "application/json" };
        try {
          const st = JSON.parse(localStorage.getItem("douzhantai_settings") || "{}");
          if (st.proxyToken) headers["Authorization"] = "Bearer " + st.proxyToken;
        } catch (_) {}
        const res = await fetch("/api/feishu", {
          method: "POST",
          headers,
          body: JSON.stringify({ query: arg || "" }),
        });
        if (!res.ok) throw new Error("feishu HTTP " + res.status);
        const d = await res.json();
        return "【飞书真实数据】\n" + (d.text || JSON.stringify(d));
      } catch (e) {
        return "【飞书工具·演示降级】未配置服务端飞书凭证，返回示例：\n竞品A | 客单价¥69 | 月销3.2万\n竞品B | 客单价¥99 | 月销1.1万";
      }
    },
  },
};

// 工具调用协议：模型在回复中插入 <<tool:name|参数>>，运行时执行后回传结果
function parseToolCalls(text) {
  const calls = [];
  const re = /<<tool:([a-zA-Z_]+)\|([^>]*)>>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    calls.push({ name: m[1], arg: m[2].trim() });
  }
  return calls;
}

/* ===================== AGENTS（4 个作战智能体） ===================== */
const AGENTS = [
  {
    id: "selection",
    name: "选品拆解",
    icon: "🔍",
    desc: "用七步拆解法把一个品类 / 商品拆成可打的卖点、人群与内容钩子。",
    placeholder: "例如：便携式迷你榨汁杯，客单价 39-79，目标一二线年轻女性",
    hint: "越具体越好：品类、价格带、目标人群",
    tools: ["feishu_fetch", "trend_fetch"],
    systemPrompt:
      "你是资深抖音电商选品拆解专家，擅长「七步拆解法」。给定品类/商品与背景，输出：①真实痛点 ②核心人群画像 ③差异化卖点 ④使用场景 ⑤价格带与利润空间 ⑥竞品破绽 ⑦内容钩子（金句）。用结构化中文，可含表格。\n可用工具：需要竞品参考时插入 <<tool:feishu_fetch|竞品关键词>> 或实时趋势 <<tool:trend_fetch|品类>>，系统返回数据后补充「竞品破绽」。可参考全局知识库历史洞察。",
    buildUser(input, ctx) {
      return (
        `请拆解以下抖音电商选品：\n${input}\n` +
        (ctx ? `\n【上游作战上下文（前序智能体结论，请继承并深化）】\n${ctx}\n` : "") +
        `\n按七步拆解法输出，给出可直接用于短视频 / 直播的钩子金句。`
      );
    },
    demoTools: [
      { name: "feishu_fetch", result: "读取竞品参考 2 行（示例）" },
      { name: "trend_fetch", result: "实时趋势 3 条（演示降级）" },
    ],
    demo: `
<h3>🔍 选品拆解 · 便携式迷你榨汁杯</h3>
<h4>① 真实痛点</h4>
<ul>
<li>想喝鲜榨但嫌榨汁机占地方、难清洗</li>
<li>上班带水果却没工具现榨，营养流失</li>
<li>市面大杯笨重，通勤 / 健身不便携</li>
</ul>
<h4>② 核心人群</h4>
<p><span class="tag">一二线白领女性</span><span class="tag">健身人群</span><span class="tag">租房党</span><span class="tag">宝妈</span></p>
<h4>③ 差异化卖点</h4>
<ul>
<li>300ml 一杯量刚好，单手可握</li>
<li>USB-C 充电，出门塞包里</li>
<li>全身可拆洗，10 秒冲净</li>
</ul>
<h4>④ 使用场景</h4>
<p>办公室下午茶 · 健身房后补充 · 带娃出门 · 宿舍夜宵</p>
<h4>⑤ 价格带与利润</h4>
<table>
<tr><th>档位</th><th>定价</th><th>毛利</th></tr>
<tr><td>引流款</td><td>¥39</td><td>~38%</td></tr>
<tr><td>主推款</td><td>¥69</td><td>~52%</td></tr>
<tr><td>套装款</td><td>¥99</td><td>~55%</td></tr>
</table>
<h4>⑥ 竞品破绽</h4>
<ul><li>多数不可拆洗 → 我们主打"10秒冲净"</li><li>容量过大 → 我们打"一杯刚好不浪费"</li></ul>
<h4>⑦ 内容钩子金句</h4>
<p><strong>"大杯榨汁机吃灰三年，这个小东西我天天带出门。"</strong><br>
<strong>"健身完別喝糖水，30 秒给自己榨一杯。"</strong></p>
`,
  },

  {
    id: "live",
    name: "直播场景",
    icon: "🎬",
    desc: "生成 9:16 直播间场景方案：色彩、关键元素、机位、话术节奏。基于选品结论。",
    placeholder: "例如：便携榨汁杯，明亮厨房风，主打健康鲜榨，客单价 69",
    hint: "描述品类 + 风格 + 主推价格（会自动继承选品结论）",
    tools: [],
    systemPrompt:
      "你是直播间场景导演，擅长把商品转成可落地的 9:16 直播间方案。必须基于【上游作战上下文】里的选品结论（卖点 / 人群 / 钩子）来设计。输出：场景色彩方案、关键道具/元素、摄像机位与构图、主播走位、话术节奏（开场-痛点-演示-逼单）、灯光建议。结构清晰可直接执行。",
    buildUser(input, ctx) {
      return (
        `为以下抖音直播设计 9:16 直播间场景方案：\n${input}\n` +
        (ctx ? `\n【上游作战上下文（选品拆解结论，请据此落地场景）】\n${ctx}\n` : "")
      );
    },
    demoTools: [],
    demo: `
<h3>🎬 直播场景方案 · 便携榨汁杯（明亮厨房风）</h3>
<h4>色彩方案</h4>
<p>主色 <code>奶白+浅木</code>，点缀 <code>橙黄果汁色</code>，干净治愈，突出"鲜"。</p>
<h4>关键元素</h4>
<ul>
<li>中岛台 + 大理石纹台面</li>
<li>一字排开的新鲜水果（橙/莓/牛油果）</li>
<li>透明玻璃杯盛成品，汁水可见</li>
<li>角落绿植增加生活感</li>
</ul>
<h4>机位与构图</h4>
<table>
<tr><th>机位</th><th>作用</th></tr>
<tr><td>主机位(正面)</td><td>主播半身+操作台全景</td></tr>
<tr><td>特写机位</td><td>榨汁过程/汁水流动特写</td></tr>
</table>
<h4>话术节奏</h4>
<ul>
<li><strong>开场(0-30s)</strong>：举杯"今天教你们带走的鲜榨自由"</li>
<li><strong>痛点(30-90s)</strong>：大榨汁机吃灰？这个塞包里</li>
<li><strong>演示(90-180s)</strong>：现场投水果→30秒出汁→一口喝</li>
<li><strong>逼单(180s+)</strong>：限时套装价 ¥99，库存倒数</li>
</ul>
<h4>灯光</h4>
<p>主光 5600K 柔光箱打亮台面，侧逆光勾果汁通透感。</p>
`,
  },

  {
    id: "material",
    name: "千川素材",
    icon: "🎞️",
    desc: "把卖点转成 3 条千川短视频脚本：钩子-痛点-产品-见证-促单。",
    placeholder: "例如：便携榨汁杯，卖点=可拆洗/USB充电/一杯量，投流目标=点击率",
    hint: "给卖点 + 投放目标（点击 / 转化 / ROI，会自动继承选品+直播结论）",
    tools: ["feishu_fetch", "trend_fetch"],
    systemPrompt:
      "你是千川素材导演。必须基于【上游作战上下文】里的选品结论（卖点/钩子/人群）与直播场景来写脚本。给定投放目标，产出 3 条 15-30s 短视频脚本，结构：钩子(前3秒)→痛点→产品演示→信任见证→促单。每条标注画面+口播+时长。口播口语化、有冲突感。\n可用工具：需要竞品脚本或实时趋势参考时插入 <<tool:feishu_fetch|竞品脚本关键词>> 或 <<tool:trend_fetch|品类>>。可参考全局知识库历史洞察。",
    buildUser(input, ctx) {
      return (
        `商品卖点与投放目标如下，请出 3 条千川短视频脚本：\n${input}\n` +
        (ctx ? `\n【上游作战上下文（选品 + 直播结论，脚本要呼应这里的钩子与场景）】\n${ctx}\n` : "")
      );
    },
    demoTools: [
      { name: "feishu_fetch", result: "读取竞品脚本参考 2 行（示例）" },
      { name: "trend_fetch", result: "实时趋势 3 条（演示降级）" },
    ],
    demo: `
<h3>🎞️ 千川素材脚本 · 便携榨汁杯（目标：点击率）</h3>
<h4>脚本 1 · 《吃灰对比》</h4>
<ul>
<li><strong>0-3s 钩子</strong>：把落灰的大榨汁机扔进柜子"它下岗了"</li>
<li><strong>痛点</strong>：占地方、洗一次想哭</li>
<li><strong>演示</strong>：掏出迷你杯，投水果 30s 出汁</li>
<li><strong>见证</strong>：弹幕"已买，真香"</li>
<li><strong>促单</strong>：左下小黄车 ¥69 起</li>
</ul>
<h4>脚本 2 · 《通勤实测》</h4>
<ul>
<li><strong>0-3s 钩子</strong>：地铁上掏出杯子现场榨</li>
<li><strong>痛点</strong>：外面卖果汁 25 一杯还掺水</li>
<li><strong>演示</strong>：USB-C 充一次用一周</li>
<li><strong>促单</strong>：套装 ¥99 更划算</li>
</ul>
<h4>脚本 3 · 《宝妈场景》</h4>
<ul>
<li><strong>0-3s 钩子</strong>：娃挑食不吃水果？</li>
<li><strong>演示</strong>：变成果汁一口喝光</li>
<li><strong>促单</strong>：可拆洗放心给娃用</li>
</ul>
`,
  },

  {
    id: "finance",
    name: "财务核算",
    icon: "📊",
    desc: "输入一场直播 / 店铺流水，自动算毛利、净利、ROI 与盈亏预警（强制调用计算器实时算）。",
    placeholder: "例如：GMV 12万，退款 1.2万，投流花费 3万，货品成本 4.5万，佣金快递 1.1万",
    hint: "给 GMV、退款、投流、货品成本等数字（会自动继承前面全部结论）",
    tools: ["calculator", "extract_table"],
    systemPrompt:
      "你是抖音电商财务核算师。给定一场直播/店铺的经营数据，计算：实收GMV、毛利、毛利率、投放ROI、净利、净利率，并给出盈亏预警与优化建议。\n★ 若用户粘贴了表格/流水文本，先用 <<tool:extract_table|文本>> 解析为结构化数据，再用 <<tool:calculator|算术表达式>> 实时计算（不要口算）：毛利率插入 <<tool:calculator|(108000-45000-11000)/108000*100>>，系统返回结果后写进结论。用表格呈现。",
    buildUser(input, ctx) {
      return (
        `本场经营数据如下，请核算利润与 ROI：\n${input}\n` +
        (ctx ? `\n【上游作战上下文（选品/直播/千川结论，财务核算请与前面策略对齐）】\n${ctx}\n` : "") +
        `\n请务必用 calculator 工具实时计算各项指标。`
      );
    },
    demoTools: [
      { name: "calculator", arg: "(108000-45000-11000)/108000*100", result: "48.1" },
      { name: "calculator", arg: "108000/30000", result: "3.6" },
      { name: "extract_table", result: "流水→结构化 JSON（示例）" },
    ],
    demo: `
<h3>📊 财务核算 · 本场直播</h3>
<table>
<tr><th>项目</th><th>金额</th><th>说明</th></tr>
<tr><td>GMV</td><td>¥120,000</td><td>成交额</td></tr>
<tr><td>退款</td><td>-¥12,000</td><td>退款后实收 GMV ¥108,000</td></tr>
<tr><td>货品成本</td><td>-¥45,000</td><td>商品成本</td></tr>
<tr><td>投流花费</td><td>-¥30,000</td><td>千川消耗</td></tr>
<tr><td>佣金+快递</td><td>-¥11,000</td><td>平台佣金与运费</td></tr>
<tr><td><strong>净利</strong></td><td><strong>¥22,000</strong></td><td>净利率 18.3%</td></tr>
</table>
<h4>关键指标（calculator 实时算）</h4>
<ul>
<li>实收 GMV：¥108,000</li>
<li>毛利率：(108000-45000-11000)/108000 ≈ <strong>48.1%</strong></li>
<li>投放 ROI：108000 / 30000 = <strong>3.6</strong>（健康线 &gt;3）</li>
<li>净利率：<strong>18.3%</strong></li>
</ul>
<h4>盈亏预警与建议</h4>
<ul>
<li>ROI 3.6 达标，可适度加投测爆量</li>
<li>退款率 10% 偏高，查品控/物流</li>
<li>毛利 48% 有空间，套装组合可提客单</li>
</ul>
`,
  },
];

/* ===================== ORCHESTRATOR（总指挥） ===================== */
// 电商作战链路：后一个 Agent 必须基于前一个的输出继续（体现多 Agent 协同 + 长时委派）
const PIPELINE = ["selection", "live", "material", "finance"];

function getAgent(id) {
  return AGENTS.find((a) => a.id === id);
}

// 汇总 4 个 Agent 的输出 → 完整作战方案（纯函数，便于复用）
function aggregateCampaign(goal, results) {
  let html = "";
  html += `<h2>⚔️ 总攻作战方案</h2>`;
  html += `<div class="goal-box">🎯 <strong>作战目标：</strong>${escapeHtml(goal)}</div>`;
  results.forEach((r, i) => {
    const a = getAgent(r.agent) || { name: r.agent || "智能体", icon: "🤖" };
    html += `<div class="step-block">`;
    html += `<div class="step-head"><span class="step-no">步骤 ${i + 1}</span> <span class="step-icon">${a.icon}</span> <strong>${a.name}</strong>`;
    if (r.tools && r.tools.length) {
      html += ` <span class="tool-badges">` +
        r.tools.map((t) => `<span class="tool-badge">🔧 ${escapeHtml(t.name)}</span>`).join("") +
        `</span>`;
    }
    if (r.demo) html += ` <span class="demo-badge">演示</span>`;
    html += `</div>`;
    html += `<div class="step-body">${r.html}</div>`;
    html += `</div>`;
  });
  html += `<div class="final-advice"><h3>🚀 总攻建议</h3>
  <p>建议用「<strong>场景痛点型</strong>」素材切入打认知，直播间用「明亮厨房风」建立信任与"鲜"的视觉，千川先小预算测<strong>点击率</strong>再放量；财务以 <strong>ROI&gt;3</strong> 为健康线，重点监控退款率。整条链路由 4 个专职智能体串联协同完成，一处结论自动喂给下一处。</p></div>`;
  return html;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { AGENTS, TOOLS, PIPELINE, getAgent, safeEvalMath, parseToolCalls, aggregateCampaign };
}
