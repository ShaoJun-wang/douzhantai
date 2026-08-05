// 抖战台 v2 · 前端运行时（编排 UI + 记忆 + 工具调用循环）
const DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

const state = {
  mode: "campaign", // 'campaign' = 一键作战总指挥；'agent' = 单模块
  current: "selection",
  settings: { apiKey: "", model: "qwen-plus", demoMode: true, proxyMode: false, proxyToken: "" },
  memory: {}, // 每个 Agent 的对话记忆（localStorage 持久化）
  knowledge: [], // 全局知识引擎：从历次作战结论提炼的洞察（跨 Agent / 跨会话复用）
};

const $ = (s) => document.querySelector(s);

/* ---------------- 初始化 ---------------- */
function init() {
  loadSettings();
  loadMemory();
  loadKnowledge();
  renderNav();
  selectMode("campaign");
  bindEvents();
  updateModeTag();
  renderKnowledgeList();
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("douzhantai_settings") || "null");
    if (s) state.settings = { ...state.settings, ...s };
  } catch (_) {}
}
function saveSettings() {
  localStorage.setItem("douzhantai_settings", JSON.stringify(state.settings));
}
function loadMemory() {
  try {
    const m = JSON.parse(localStorage.getItem("douzhantai_memory") || "null");
    if (m) state.memory = m;
  } catch (_) {}
}
function saveMemory() {
  try {
    localStorage.setItem("douzhantai_memory", JSON.stringify(state.memory));
  } catch (_) {}
}
function loadKnowledge() {
  try {
    const k = JSON.parse(localStorage.getItem("douzhantai_knowledge") || "null");
    if (Array.isArray(k)) state.knowledge = k;
  } catch (_) {}
}
function saveKnowledge() {
  try {
    localStorage.setItem("douzhantai_knowledge", JSON.stringify(state.knowledge));
  } catch (_) {}
}

/* ---------------- 导航 ---------------- */
function renderNav() {
  const nav = $("#nav");
  nav.innerHTML = "";
  // 一键作战入口
  const war = document.createElement("button");
  war.className = "nav-btn war" + (state.mode === "campaign" ? " active" : "");
  war.innerHTML = `<span class="ico">⚔️</span><span>一键作战</span>`;
  war.onclick = () => selectMode("campaign");
  nav.appendChild(war);
  // 分隔
  const sep = document.createElement("div");
  sep.className = "nav-sep";
  sep.textContent = "专职智能体";
  nav.appendChild(sep);
  // 4 个 Agent
  AGENTS.forEach((a) => {
    const btn = document.createElement("button");
    btn.className = "nav-btn" + (state.mode === "agent" && state.current === a.id ? " active" : "");
    btn.innerHTML = `<span class="ico">${a.icon}</span><span>${a.name}</span>`;
    btn.onclick = () => selectMode("agent", a.id);
    nav.appendChild(btn);
  });
}

function selectMode(mode, id) {
  state.mode = mode;
  if (id) state.current = id;
  if (mode === "campaign") {
    $("#campaignView").classList.remove("hidden");
    $("#agentView").classList.add("hidden");
  } else {
    $("#agentView").classList.remove("hidden");
    $("#campaignView").classList.add("hidden");
    const a = getAgent(state.current);
    $("#modName").textContent = `${a.icon} ${a.name}`;
    $("#modDesc").textContent = a.desc;
    $("#userInput").placeholder = a.placeholder;
    $("#inputHint").textContent = "提示：" + a.hint;
    renderOutputPlaceholder();
    renderHistory(a.id);
  }
  renderNav();
}

function selectModule(id) {
  selectMode("agent", id);
}

/* ---------------- LLM + 工具调用循环 ---------------- */
async function postChat(body) {
  const { proxyMode, apiKey } = state.settings;
  if (proxyMode) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error("代理 HTTP " + res.status);
    return await res.json();
  }
  if (!apiKey) throw new Error("无 Key");
  const res = await fetch(DASHSCOPE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body,
  });
  if (!res.ok) throw new Error("直连 HTTP " + res.status);
  return await res.json();
}

// 调用单个 Agent：支持记忆 + 工具调用循环
async function callLLM(agent, userText, ctx) {
  const { apiKey, model, demoMode, proxyMode } = state.settings;
  // 演示 / 无 Key 降级
  if (demoMode && !proxyMode) {
    return { text: agent.demo, demo: true, tools: agent.demoTools || [] };
  }
  if (!proxyMode && !apiKey) {
    return { text: agent.demo, demo: true, tools: agent.demoTools || [] };
  }

  // 注入知识引擎：复用历史洞察（跨 Agent / 跨会话）
  const kb = relevantKnowledge(userText);
  const sysContent = agent.systemPrompt + (kb ? "\n\n【全局知识库历史洞察（可复用前序结论）】\n" + kb : "");
  const messages = [{ role: "system", content: sysContent }];
  // 注入该 Agent 自身记忆（最多 6 轮）
  (state.memory[agent.id] || []).slice(-6).forEach((t) => {
    messages.push({ role: "user", content: t.input });
    messages.push({ role: "assistant", content: stripTags(t.output) });
  });
  messages.push({ role: "user", content: agent.buildUser(userText, ctx) });

  const usedTools = [];
  let finalRaw = "";
  for (let iter = 0; iter < 3; iter++) {
    const body = JSON.stringify({ model, messages, temperature: 0.8, max_tokens: 1500 });
    let data;
    try {
      data = await postChat(body);
    } catch (e) {
      return { text: agent.demo + `<p class="placeholder">⚠️ 调用失败（${e.message}），已回退演示结果。</p>`, demo: true, tools: agent.demoTools || [] };
    }
    const text = data.choices?.[0]?.message?.content || "";
    finalRaw = text;
    const calls = parseToolCalls(text);
    if (!calls.length) {
      return { text: renderMD(text), demo: false, tools: usedTools };
    }
    // 执行工具
    let toolReport = "\n【工具执行结果】\n";
    calls.forEach((c) => {
      const tool = TOOLS[c.name];
      if (!tool) {
        toolReport += `· ${c.name}: 未找到该工具\n`;
        return;
      }
      const out = tool.run(c.arg);
      usedTools.push({ name: c.name, arg: c.arg, result: out });
      toolReport += `· ${c.name}(${c.arg || ""}): ${out}\n`;
    });
    const cleaned = text.replace(/<<tool:[a-zA-Z_]+\|[^>]*>>/g, "");
    messages.push({ role: "assistant", content: cleaned + "\n(已请求工具，详见下方结果)" });
    messages.push({ role: "user", content: toolReport + "\n请基于以上工具结果，产出你的最终结论。" });
  }
  return { text: renderMD(finalRaw), demo: false, tools: usedTools };
}

/* ---------------- 单模块运行 ---------------- */
async function runAgentModule() {
  const a = getAgent(state.current);
  const input = $("#userInput").value.trim();
  if (!input) {
    toast("先填点需求再作战～");
    return;
  }
  setRunning(true);
  const r = await callLLM(a, input, "");
  // 记忆
  state.memory[a.id] = state.memory[a.id] || [];
  state.memory[a.id].push({ input, output: r.text, time: Date.now() });
  if (state.memory[a.id].length > 12) state.memory[a.id].shift();
  saveMemory();
  recordKnowledge(a.id, r.text); // 沉淀洞察到全局知识库
  renderOutput(r, a);
  renderHistory(a.id);
  setRunning(false);
}

function renderOutput(r, a) {
  let html = "";
  if (r.demo) {
    html += '<p class="placeholder">🧪 当前为<strong>演示模式</strong>结果（内置样例）。填入百炼 API Key 或启用本地代理后即为实时生成。</p>';
  }
  if (r.tools && r.tools.length) {
    html += `<div class="tool-badges">${r.tools.map((t) => `<span class="tool-badge">🔧 ${escapeHtml(t.name)}</span>`).join("")}</div>`;
  }
  html += r.text;
  $("#output").innerHTML = html;
}

function renderHistory(id) {
  const box = $("#history");
  const list = state.memory[id] || [];
  if (!list.length) {
    box.innerHTML = '<p class="placeholder small">暂无记忆。运行后这里会保留本智能体的历史作战记录（跨轮记忆）。</p>';
    return;
  }
  box.innerHTML = list
    .slice()
    .reverse()
    .map((t, i) => `<div class="hist-item"><div class="hist-q">▸ ${escapeHtml(t.input.slice(0, 60))}</div><div class="hist-a">${escapeHtml(stripTags(t.output).slice(0, 80))}…</div></div>`)
    .join("");
}

function renderOutputPlaceholder() {
  $("#output").innerHTML = '<p class="placeholder">选择左侧模块，填入需求，点击「运行作战」即可看到结果。</p>';
  $("#history").innerHTML = "";
}

/* ---------------- 一键作战（总指挥编排） ---------------- */
async function runCampaign() {
  const goal = $("#goalInput").value.trim();
  if (!goal) {
    toast("先写作战目标，总指挥才能拆解委派～");
    return;
  }
  setCampaignRunning(true);
  $("#campaignSteps").innerHTML = "";
  $("#campaignResult").innerHTML = '<p class="placeholder">⚔️ 总指挥正在拆解目标，依次委派 4 个智能体协同作战…</p>';

  const ctxChain = [];
  const results = [];
  for (let i = 0; i < PIPELINE.length; i++) {
    const a = getAgent(PIPELINE[i]);
    const stepEl = addStepCard(i, a);
    const ctx = ctxChain.join("\n\n---\n\n");
    let r;
    try {
      r = await callLLM(a, goal, ctx);
    } catch (e) {
      r = { text: a.demo, demo: true, tools: a.demoTools || [] };
    }
    // 把本次结果以纯文本喂给下一个 Agent（多 Agent 协同 / 长时委派）
    ctxChain.push(`【${a.name}】\n${stripTags(r.text)}`);
    results.push({ agent: a.id, html: r.text, tools: r.tools, demo: r.demo });
    updateStepCard(stepEl, a, r);
    recordKnowledge(a.id, r.text); // 沉淀洞察到全局知识库
  }

  const finalHtml = aggregateCampaign(goal, results);
  $("#campaignResult").innerHTML = finalHtml;
  setCampaignRunning(false);
  toast("作战方案已生成 ⚔️");
}

function addStepCard(i, a) {
  const wrap = document.createElement("div");
  wrap.className = "step-card running";
  wrap.innerHTML = `<div class="step-card-head"><span class="step-no">步骤 ${i + 1}</span> <span class="step-icon">${a.icon}</span> <strong>${a.name}</strong> <span class="step-spin">⏳ 作战中…</span></div>`;
  $("#campaignSteps").appendChild(wrap);
  return wrap;
}
function updateStepCard(el, a, r) {
  let badges = "";
  if (r.tools && r.tools.length) {
    badges += `<span class="tool-badges">${r.tools.map((t) => `<span class="tool-badge">🔧 ${escapeHtml(t.name)}</span>`).join("")}</span>`;
  }
  if (r.demo) badges += ` <span class="demo-badge">演示</span>`;
  el.className = "step-card done";
  el.innerHTML = `<div class="step-card-head"><span class="step-no">步骤 ${PIPELINE.indexOf(a.id) + 1}</span> <span class="step-icon">${a.icon}</span> <strong>${a.name}</strong> <span class="step-ok">✓ 完成</span> ${badges}</div><div class="step-preview">${escapeHtml(stripTags(r.text).slice(0, 90))}…</div>`;
}

/* ---------------- Markdown 渲染（含表格/工具语法） ---------------- */
function renderMD(t) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = esc(t).replace(/\r/g, "").split("\n");
  let html = "";
  let inList = false;
  let table = null; // {head:[], rows:[]}
  const flushTable = () => {
    if (!table) return;
    html += "<table><tr>" + table.head.map((h) => `<th>${h}</th>`).join("") + "</tr>";
    table.rows.forEach((row) => (html += "<tr>" + row.map((c) => `<td>${c}</td>`).join("") + "</tr>"));
    html += "</table>";
    table = null;
  };
  for (let raw of lines) {
    let line = raw.replace(/\s+$/, "");
    // 表格行
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().split("|").slice(1, -1).map((c) => c.trim().replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"));
      if (/^[\s:|-]+$/.test(line.replace(/\|/g, ""))) {
        // 分隔行，跳过
        if (!table) table = { head: [], rows: [] };
        continue;
      }
      if (!table) table = { head: [], rows: [] };
      if (table.head.length === 0) table.head = cells;
      else table.rows.push(cells);
      continue;
    } else {
      flushTable();
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + line.replace(/^\s*[-*]\s+/, "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") + "</li>";
      continue;
    } else if (inList) { html += "</ul>"; inList = false; }
    if (/^###\s+/.test(line)) html += "<h4>" + line.replace(/^###\s+/, "") + "</h4>";
    else if (/^##\s+/.test(line)) html += "<h3>" + line.replace(/^##\s+/, "") + "</h3>";
    else if (/^#\s+/.test(line)) html += "<h3>" + line.replace(/^#\s+/, "") + "</h3>";
    else if (line.trim() === "") html += "";
    else html += "<p>" + line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") + "</p>";
  }
  flushTable();
  if (inList) html += "</ul>";
  return html;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/* ---------------- 知识引擎（记忆升级） ---------------- */
// 从作战结论提炼洞察：规则命中关键词 + 长度约束，去重沉淀
function extractInsights(html) {
  const plain = stripTags(html);
  const lines = plain.split(/[。；;！!]/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out = [];
  const KEY = /(钩子|卖点|预警|人群|痛点|ROI|毛利|场景|破绽|建议|复购|转化)/;
  for (const line of lines) {
    if (KEY.test(line) && line.length >= 6 && line.length <= 60) out.push(line);
    if (out.length >= 3) break;
  }
  return out;
}

// 记录洞察到全局知识库（跨 Agent / 跨会话复用）
function recordKnowledge(agentId, html) {
  const ins = extractInsights(html);
  if (!ins.length) return;
  ins.forEach((text) => {
    if (state.knowledge.some((k) => k.text === text)) return; // 去重
    state.knowledge.push({ agent: agentId, text, time: Date.now() });
  });
  if (state.knowledge.length > 20) state.knowledge = state.knowledge.slice(-20);
  saveKnowledge();
  renderKnowledgeList();
}

// 按当前输入召回相关知识（关键词命中，失败回退最近 5 条）
function relevantKnowledge(userText) {
  if (!state.knowledge.length) return "";
  const kws = String(userText || "").split(/[\s,，、]+/).filter((w) => w.length >= 2);
  const matched = state.knowledge.filter((k) => kws.some((w) => k.text.includes(w)));
  const pool = matched.length ? matched : state.knowledge.slice(-5);
  return pool.slice(-5).map((k) => "· " + k.text).join("\n");
}

// 渲染全局知识库面板
function renderKnowledgeList() {
  const box = document.getElementById("kbList");
  if (!box) return;
  if (!state.knowledge.length) {
    box.innerHTML = '<p class="placeholder small">暂无知识。运行作战后，系统会从结论中自动提炼洞察沉淀到这里，下次同品类作战自动复用（跨智能体 / 跨会话）。</p>';
    return;
  }
  box.innerHTML = state.knowledge
    .slice()
    .reverse()
    .map((k) => {
      const name = (getAgent(k.agent) || { name: k.agent }).name;
      return `<div class="hist-item"><div class="hist-q">▸ ${escapeHtml(k.text)}</div><div class="hist-a">来源：${escapeHtml(name)}</div></div>`;
    })
    .join("");
}

/* ---------------- 设置弹窗 ---------------- */
function openSettings() {
  $("#apiKeyInput").value = state.settings.apiKey;
  $("#modelSelect").value = state.settings.model;
  $("#demoToggle").checked = state.settings.demoMode;
  $("#proxyToggle").checked = state.settings.proxyMode;
  $("#proxyTokenInput").value = state.settings.proxyToken || "";
  updateKeyStatus();
  $("#settingsModal").classList.remove("hidden");
}
function closeSettings() { $("#settingsModal").classList.add("hidden"); }
function updateKeyStatus() {
  const k = $("#apiKeyInput").value.trim();
  const el = $("#keyStatus");
  if (!k && !state.settings.proxyMode) { el.textContent = "未填写 Key → 将使用演示模式"; el.className = "modal-note warn"; }
  else if (state.settings.proxyMode) { el.textContent = "本地代理模式：Key 走服务端环境变量 ✓"; el.className = "modal-note ok"; }
  else { el.textContent = "已填写 Key（长度 " + k.length + "）✓"; el.className = "modal-note ok"; }
}
function saveSettingsFromUI() {
  state.settings.apiKey = $("#apiKeyInput").value.trim();
  state.settings.model = $("#modelSelect").value;
  state.settings.demoMode = $("#demoToggle").checked;
  state.settings.proxyMode = $("#proxyToggle").checked;
  state.settings.proxyToken = $("#proxyTokenInput").value.trim();
  saveSettings();
  updateModeTag();
  closeSettings();
  toast("设置已保存");
}
function clearMemory() {
  if (!confirm("确定清空所有智能体的本地记忆？此操作不可恢复。")) return;
  state.memory = {};
  saveMemory();
  if (state.mode === "agent") renderHistory(state.current);
  toast("记忆已清空");
}
function updateModeTag() {
  const tag = $("#modeTag");
  if (state.settings.proxyMode) { tag.textContent = "本地代理"; tag.className = "mode-tag live"; }
  else if (state.settings.demoMode || !state.settings.apiKey) { tag.textContent = "演示模式"; tag.className = "mode-tag"; }
  else { tag.textContent = "实时 · " + state.settings.model; tag.className = "mode-tag live"; }
}

/* ---------------- 状态 / 工具 ---------------- */
function setRunning(b) {
  const btn = $("#runBtn");
  btn.disabled = b;
  btn.textContent = b ? "⏳ 作战中…" : "▶ 运行作战";
}
function setCampaignRunning(b) {
  const btn = $("#campaignRun");
  btn.disabled = b;
  btn.textContent = b ? "⏳ 总指挥委派中…" : "⚔️ 一键作战";
}
function bindEvents() {
  $("#runBtn").onclick = runAgentModule;
  $("#campaignRun").onclick = runCampaign;
  $("#settingsBtn").onclick = openSettings;
  $("#closeSettings").onclick = closeSettings;
  $("#saveSettings").onclick = saveSettingsFromUI;
  $("#clearMemory").onclick = clearMemory;
  $("#apiKeyInput").oninput = updateKeyStatus;
  $("#proxyToggle").onchange = updateKeyStatus;
  $("#copyBtn").onclick = () => {
    const text = $("#output").innerText;
    navigator.clipboard.writeText(text).then(() => toast("结果已复制"));
  };
  $("#copyCampaign").onclick = () => {
    const text = $("#campaignResult").innerText;
    navigator.clipboard.writeText(text).then(() => toast("作战方案已复制"));
  };
  $("#settingsModal").onclick = (e) => { if (e.target.id === "settingsModal") closeSettings(); };
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

init();
