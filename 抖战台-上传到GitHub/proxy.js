// 抖战台 · 本地代理（零依赖）
// 作用：把前端请求转发到阿里云百炼，Key 只放服务端环境变量，避免浏览器跨域(CORS)与 Key 泄露。
// 用法：
//   set DASHSCOPE_API_KEY=sk-xxxx
//   node proxy.js
// 然后浏览器打开 http://localhost:3000
//
// 真实飞书读取（可选，冲奖加分项）：在 .env 中配置以下三项即激活 feishu_real 工具
//   FEISHU_APP_ID=cli_xxxx
//   FEISHU_APP_SECRET=xxxx
//   FEISHU_APP_TOKEN=bascnxxxx   （多维表格 URL 中的 app_token）
// 不配置则 feishu_real 自动降级为示例，演示模式零依赖可用。
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.DASHSCOPE_API_KEY || "";
// 百炼兼容 OpenAI 协议的接入点
const DASHSCOPE = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const ROOT = __dirname;

// 零依赖读取同目录 .env（不引入 dotenv 包），仅在不覆盖已有环境变量的前提下注入
function loadEnv() {
  try {
    const ep = path.join(ROOT, ".env");
    if (!fs.existsSync(ep)) return;
    const txt = fs.readFileSync(ep, "utf-8");
    txt.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) return;
      const k = m[1];
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    });
  } catch (_) {}
}
loadEnv();

// 飞书凭证（真实版飞书工具链）：从环境变量 / .env 读取，绝不硬编码明文
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || "";
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const FEISHU_APP_TOKEN = process.env.FEISHU_APP_TOKEN || "";
// 真实版访问令牌（可选）：设置后，调用敏感端点（/api/feishu）必须带 Authorization: Bearer <token>，防公网裸部署被白嫖读飞书
const PROXY_ACCESS_TOKEN = process.env.PROXY_ACCESS_TOKEN || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

// 通用 JSON GET（真实 HTTP 调用，用于趋势工具链）
async function getJson(url, headers) {
  const r = await fetch(url, { headers: headers || {} });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

// 通用 JSON POST（飞书 tenant_access_token 等需要 POST 的接口）
async function postJson(url, payload, headers) {
  const r = await fetch(url, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}),
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

const server = http.createServer((req, res) => {
  // ---- 健康检查（部署后探测可达性用） ----
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, key: !!KEY, time: Date.now() }));
    return;
  }

  // ---- 代理接口：接收完整 messages（含 system）+ model ----
  if (req.method === "POST" && req.url === "/api/chat") {
    if (!KEY) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "服务端未配置 DASHSCOPE_API_KEY" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "请求体不是合法 JSON" }));
        return;
      }
      const upstream = {
        model: payload.model || "qwen-plus",
        messages: Array.isArray(payload.messages) ? payload.messages : [],
        temperature: typeof payload.temperature === "number" ? payload.temperature : 0.8,
        max_tokens: payload.max_tokens || 1500,
      };
      if (!upstream.messages.length) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "messages 为空" }));
        return;
      }
      const opts = {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: "Bearer " + KEY,
        },
      };
      const r = https.request(DASHSCOPE, opts, (up) => {
        const chunks = [];
        up.on("data", (d) => chunks.push(d));
        up.on("end", () => {
          res.writeHead(up.statusCode, { "Content-Type": "application/json; charset=utf-8" });
          res.end(Buffer.concat(chunks));
        });
      });
      r.on("error", (e) => {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: e.message }));
      });
      r.write(JSON.stringify(upstream));
      r.end();
    });
    return;
  }

  // ---- 实时趋势工具链：真实 HTTP 拉取公开热榜（无需鉴权，合规） ----
  if (req.method === "POST" && req.url === "/api/trend") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let list = [];
      try {
        // 主源：微博热搜（公开、无需鉴权，真实热点，适合抖音选题参考）
        const wb = await getJson("https://weibo.com/ajax/side/hotSearch", {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://weibo.com/",
        });
        const realtime = (wb && wb.data && wb.data.realtime) || [];
        list = realtime
          .filter((x) => x && x.word)
          .slice(0, 8)
          .map((x) => ({ word: x.word, title: x.word, num: x.num }));
      } catch (_) {}
      if (!list.length) {
        // 备源：GitHub 趋势仓库（公开、无需鉴权，稳定可靠）
        try {
          const gh = await getJson(
            "https://api.github.com/search/repositories?q=ecommerce&sort=stars&order=desc&per_page=8",
            { "User-Agent": "douzhantai", Accept: "application/vnd.github+json" }
          );
          list = (gh.items || [])
            .slice(0, 8)
            .map((x) => ({ word: x.full_name, title: x.full_name, stars: x.stargazers_count }));
        } catch (_) {}
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ list }));
    });
    return;
  }

  // ---- 真实飞书读取（可选，需服务端 FEISHU 凭证 + 多维表格 app_token；未配置则降级，前端回退示例） ----
  if (req.method === "POST" && req.url === "/api/feishu") {
    // 访问令牌校验（仅当服务端配置了 PROXY_ACCESS_TOKEN 时启用）
    if (PROXY_ACCESS_TOKEN) {
      const auth = req.headers["authorization"] || "";
      if (auth !== "Bearer " + PROXY_ACCESS_TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ text: "", configured: false, error: "未授权：缺少正确的代理访问令牌" }));
        return;
      }
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let reqBody = {};
      try { reqBody = JSON.parse(body || "{}"); } catch (_) {}
      const appId = FEISHU_APP_ID;
      const appSecret = FEISHU_APP_SECRET;
      const appToken = reqBody.app_token || FEISHU_APP_TOKEN;
      if (!appId || !appSecret || !appToken) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          text: "",
          configured: false,
          reason: !appToken ? "缺少 FEISHU_APP_TOKEN（多维表格 app_token）" : "缺少 FEISHU_APP_ID / FEISHU_APP_SECRET",
        }));
        return;
      }
      try {
        // 1) 取 tenant_access_token（飞书服务端凭证，不落前端）
        const tk = await postJson("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
          app_id: appId,
          app_secret: appSecret,
        });
        const token = tk.tenant_access_token;
        if (!token) throw new Error("获取 tenant_access_token 失败：" + JSON.stringify(tk));
        const auth = { Authorization: "Bearer " + token };

        // 2) 解析目标表（未指定则用表格第一个数据表）
        let tableId = reqBody.table_id;
        if (!tableId) {
          const tables = await getJson(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
            auth
          );
          const items = (tables.data && tables.data.items) || [];
          if (!items.length) throw new Error("该多维表格无数据表");
          tableId = items[0].table_id;
        }

        // 3) 读取前 10 行记录
        const rec = await getJson(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=10`,
          auth
        );
        const records = (rec.data && rec.data.items) || [];

        // 4) 拼成纯文本（字段名: 值），供 Agent 直接引用
        const lines = records.map((r, i) => {
          const f = r.fields || {};
          const kv = Object.keys(f)
            .map((k) => `${k}: ${JSON.stringify(f[k])}`)
            .join(" | ");
          return `【行${i + 1}】 ${kv}`;
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ text: lines.join("\n"), configured: true, rows: records.length, table_id: tableId }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ text: "", configured: true, error: e.message }));
      }
    });
    return;
  }

  // ---- 静态文件 ----
  let urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`抖战台代理已启动: http://localhost:${PORT}`);
  console.log(KEY ? "✓ 已读取 DASHSCOPE_API_KEY" : "✗ 未检测到 DASHSCOPE_API_KEY，请先设置环境变量（仍可演示模式运行）");
  console.log(
    FEISHU_APP_ID && FEISHU_APP_SECRET && FEISHU_APP_TOKEN
      ? "✓ 已读取 FEISHU 凭证，feishu_real 真实读取已激活"
      : "✗ 未检测到 FEISHU 凭证（FEISHU_APP_ID/SECRET/APP_TOKEN），feishu_real 将降级为示例"
  );
  console.log(
    PROXY_ACCESS_TOKEN
      ? "🔒 已启用代理访问令牌（PROXY_ACCESS_TOKEN），/api/feishu 需带 Bearer 鉴权"
      : "⚠️ 未设置代理访问令牌，/api/feishu 不鉴权（公网部署有泄露风险，建议设置）"
  );
});
