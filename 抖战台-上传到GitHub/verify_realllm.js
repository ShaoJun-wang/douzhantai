// 抖战台 · 真实 LLM 验证脚本（不含任何 Key，Key 仅从环境变量读取）
// 用法：  DASHSCOPE_API_KEY=sk-xxxx node verify_realllm.js
// 作用：  验证「选品 Agent 系统提示 + 真实百炼模型」链路是否跑通、返回质量、是否触发工具标记
const https = require("https");
const A = require("./agents.js");

const KEY = process.env.DASHSCOPE_API_KEY;
if (!KEY) {
  console.error("✗ 缺少 DASHSCOPE_API_KEY 环境变量，无法验证");
  process.exit(1);
}
const DASHSCOPE = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

// 用真实「选品指挥官」Agent 的 systemPrompt + 模拟用户的 buildUser，验证真 LLM 下的编排质量
const ag = A.getAgent("selection");
const goal = "30天把抖音小店GMV做到50万，客单价80元，目标ROI 2.5";
const messages = [
  { role: "system", content: ag.systemPrompt },
  { role: "user", content: ag.buildUser(goal, {}) },
];

const t0 = Date.now();
const data = JSON.stringify({
  model: "qwen-plus",
  messages,
  temperature: 0.8,
  max_tokens: 1500,
});

const req = https.request(
  DASHSCOPE,
  {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
  },
  (res) => {
    let buf = "";
    res.on("data", (d) => (buf += d));
    res.on("end", () => {
      const ms = Date.now() - t0;
      try {
        const j = JSON.parse(buf);
        if (j.error) {
          console.log("✗ 百炼返回错误:", JSON.stringify(j.error).slice(0, 300));
          process.exit(2);
        }
        const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
        console.log("HTTP:", res.statusCode, "| 模型:", j.model, "| 耗时:", ms + "ms");
        console.log("返回长度:", content.length, "字符");
        console.log("含工具标记 <<tool:>>:", content.includes("<<tool:"));
        console.log("含选品关键词(选品/品类/爆款/ROI/GMV):", /选品|品类|爆款|ROI|GMV/.test(content));
        console.log("含计算器表达式(如 <<tool:calculator|):", /<<tool:calculator\|/.test(content));
        console.log("\n---- 内容前 700 字 ----");
        console.log(content.slice(0, 700));
        console.log("\n✅ 真实 LLM 链路验证完成");
      } catch (e) {
        console.log("✗ 响应解析失败:", buf.slice(0, 400));
        process.exit(3);
      }
    });
  }
);
req.on("error", (e) => {
  console.error("✗ 请求错误:", e.message);
  process.exit(4);
});
req.write(data);
req.end();
