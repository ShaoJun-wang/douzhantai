# 抖战台 · 部署指南（Deployment）

> 外滩大会·黑客松 2026 · 参赛作品「抖战台 Dou Zhan Tai」
> 抖音电商 AI 作战台 —— 真·多智能体编排（选品→直播→素材→财务）+ 工具调用 + 跨模块记忆 + 长时委派

---

## 〇、先说结论（老板一眼看清）

| 能力 | 是否需要服务器 | 是否需要 Key | 公网访问 |
|---|---|---|---|
| **演示模式**（内置示例，评委零配置） | ❌ 不需要 | ❌ 不需要 | ✅ 任意静态托管 |
| **本地代理模式**（真实 LLM，Key 走服务端） | ✅ `node proxy.js` | ✅ 百炼 Key（服务端环境变量） | ✅ 任何 Node 主机 |
| **浏览器直连模式**（真实 LLM，Key 在浏览器） | ❌ 不需要（但需 CORS 放行，一般不推荐） | ✅ 百炼 Key（浏览器填） | ⚠️ 仅本地/同源 |

**最省事的公网提交方案**：把本目录 4 个静态文件推到 GitHub Pages / Vercel / CloudStudio 静态托管 → 评委打开即见完整演示（内置示例数据，零依赖、零配置）。

---

## 一、零依赖确认 ✅

`proxy.js` 只用到 Node 内置模块：`http` / `fs` / `path`。**不需要 `npm install`，有 Node 即可跑。**

```bash
node -v        # 需 >= 16（已验证 22.22.2）
```

---

## 二、方式 A：纯静态托管（演示模式，强烈推荐做公网提交）

演示模式是**默认开启**的（`app.js` 中 `demoMode: true`），打开页面即自动用内置示例数据，不需要任何后端。

**步骤：**
1. 只上传这 4 个文件到任意静态托管平台：
   - `index.html`
   - `app.js`
   - `agents.js`
   - `styles.css`
2. 平台给的 URL 直接发给评委。

适用平台（任选其一）：
- **GitHub Pages**：把 4 文件放进仓库根或 `/docs`，开 Pages。
- **Vercel / Netlify**：拖文件夹即部署，自动给 `.vercel.app` / `.netlify.app` 公网域名。
- **CloudStudio**（WorkBuddy 内置）：新建静态空间 → 上传目录 → 启动静态服务器，得公网 URL。
- **任意对象存储 + CDN**（如阿里云 OSS、腾讯云 COS 开静态网站）。

> 演示模式下「一键作战」「单模块运行」均可用，输出为内置示例，评委无需任何配置即可体验完整多智能体链路。

---

## 三、方式 B：Node 服务器（真实 LLM，全功能）

需要真实调用大模型时，跑 `proxy.js`（它既托管静态文件、又代理 `/api/chat` 到百炼，避免浏览器直连 CORS 问题，**Key 只在服务端**）。

**本地跑：**
```bash
cd douzhantai
node proxy.js
# 打开 http://localhost:3000
```

**带百炼 Key 跑（推荐，Key 不落前端）：**
```bash
cd douzhantai
export DASHSCOPE_API_KEY="sk-你的百炼Key"
node proxy.js
```
> `proxy.js` 会读环境变量 `DASHSCOPE_API_KEY`；浏览器里把「本地代理模式」开关打开即可走 `/api/chat` 代理。

**部署到公网 Node 主机（Railway / Render / 云服务器）：**
1. 上传整个 `douzhantai/` 目录。
2. 启动命令：`node proxy.js`（监听 `process.env.PORT || 3000`）。
3. 设置环境变量 `DASHSCOPE_API_KEY`。
4. 平台给的公网 URL（如 `xxx.railway.app`）即最终访问地址。

健康检查：`GET /api/health` → `{"ok":true,"key":<是否配置了Key>,"time":<时间戳>}`。

---

## 四、方式 C：浏览器直连（不推荐，仅本地调试用）

在页面「设置」里填百炼 Key 并关闭「本地代理模式」「演示模式」，前端会直接请求百炼 OpenAI 兼容接口。
⚠️ 浏览器直连百炼通常受 CORS 限制，公网部署不建议此方式；公网请用方式 B 的代理。

---

## 五、环境变量 / 设置项对照

| 项 | 位置 | 说明 |
|---|---|---|
| `DASHSCOPE_API_KEY` | 服务端环境变量 | 方式 B 用，Key 不暴露给前端 |
| 百炼 Key（浏览器） | 页面设置弹窗 | 方式 C 用，会存 localStorage |
| 模型名 | 页面设置弹窗（默认 `qwen-plus`） | 百炼支持的模型，如 `qwen-plus` / `qwen-max` |
| 演示模式开关 | 页面设置弹窗（默认开） | 开 → 用内置示例，不需 Key |
| 本地代理开关 | 页面设置弹窗（默认关） | 开 → 走 `/api/chat` 代理到百炼 |

百炼接口：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`（OpenAI 兼容）。

---

## 六、本机已验证（构建环境实跑结果）

- `node --check`：proxy.js / agents.js / app.js 全部语法通过 ✅
- 本地代理：`GET /` → 200；`GET /api/health` → `{"ok":true,"key":false}` ✅
- 内核冒烟（无浏览器/无 Key）：四 Agent 串联 → 总攻方案 4397 字符、4 个 step-block、工具徽章、演示标记齐全；注入攻击被 `safeEvalMath` 拦截（返回 null）；HTML 经 `escapeHtml` 转义防 XSS ✅
- 红线扫描：历史赛道限定词在代码中零命中（作品为品类无关通用作战台）✅

> 注：构建沙箱环境无法对外建立隧道（localtunnel 等受阻），故未能在此直接产出公网 URL；请按上述「方式 A / B」在你自己的主机或 CloudStudio 一键部署即得公网访问。

---

## 七、百炼 Key 安全红线（提交前必读）

- **Key 永不写入代码或仓库**（已确保：代理从环境变量读、前端仅在 localStorage 暂存，全程无硬编码）。
- **你自己填 Key 最安全（推荐，不必交给任何人）：**
  - 本地自测：打开页面 → ⚙️ 设置 → 把 Key 粘进「API Key」框 → 保存。Key 只存在你浏览器 localStorage，不外传。
  - 公网部署：用「方式 B」，把 Key 设为服务器环境变量 `DASHSCOPE_API_KEY`，并在页面打开「本地代理模式」。Key 只在服务端，前端拿不到。
- **公网部署务必走方式 B，不要浏览器直连（方式 C）**：方式 C 会把 Key 留在前端，任何人开 DevTools 即可抄走，且受 CORS 限制。
- **真要交给开发者验证**：聊天里贴一次即可，但贴完请立刻去百炼控制台「密钥管理」**轮换/作废旧 Key**（聊天记录不是存密处）。开发者不会把 Key 写进代码或记进记忆。
