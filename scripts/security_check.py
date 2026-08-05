# -*- coding: utf-8 -*-
"""
抖战台 · 提交前凭据泄露自检脚本（零依赖，标准库即可运行）
用法：
    python security_check.py [要扫描的目录，默认当前目录]
作用：
    在把作品上传/提交前，扫描目录里有没有"真实凭据"混进了会被提交的文件，
    包括：飞书 App ID(cli_)/Secret/多维表格 app_token(bascn)、飞书表格分享链接、
    百炼/DeepSeek/OpenAI Key(sk-)、GitHub Token(ghp_/ghu_)、明文 tenant_access_token 等。
退出码：
    0 = 干净，可安全提交
    1 = 检测到疑似真实凭据，禁止提交（请先移除或确认已被 .gitignore 忽略）
"""
import os
import re
import sys

# ---- 占位符/示例白名单：命中这些词的行视为"样例"，不算泄露 ----
PLACEHOLDER_HINTS = [
    "xxxx", "xxxxx", "示例", "占位", "placeholder", "your-", "your_", "yourkey",
    "在此填入", "填入你的", "example", "sample", "sk-your", "cli_xxxx",
    "bascnxxxx", "替换为", "<token>", "<此处值>", "此处值", "随机", "strong-random",
]

# ---- 真实凭据特征（尽量收窄，避免误伤）----
PATTERNS = {
    "百炼/DeepSeek/OpenAI Key (sk-)":    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    "飞书 App ID (cli_)":                re.compile(r"cli_[a-z0-9]{14,}"),
    "飞书多维表格 app_token (bascn)":    re.compile(r"bascn[A-Za-z0-9]{10,}"),
    "飞书表格分享链接":                   re.compile(r"https?://[A-Za-z0-9.\-]*feishu\.(?:cn|com)/base/[A-Za-z0-9]+"),
    "GitHub Token (ghp_/ghu_/gho_)":     re.compile(r"gh[pous]_[A-Za-z0-9]{30,}"),
    "明文 tenant_access_token":          re.compile(r"tenant_access_token[\"'\s:=]+[A-Za-z0-9]{20,}"),
}

# ---- 不扫描的目录 ----
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".idea", ".vscode"}
# ---- 只扫文本类文件 ----
TEXT_EXT = {
    ".js", ".ts", ".py", ".json", ".md", ".txt", ".html", ".css",
    ".env", ".example", ".yml", ".yaml", ".sh", ".ini", ".conf", "",
}


def is_placeholder(line: str) -> bool:
    low = line.lower()
    return any(h.lower() in low for h in PLACEHOLDER_HINTS)


def load_gitignore(root: str):
    """粗略解析 .gitignore，判断 .env 是否已被忽略"""
    gi = os.path.join(root, ".gitignore")
    ignored = set()
    if os.path.exists(gi):
        try:
            with open(gi, "r", encoding="utf-8", errors="ignore") as f:
                for ln in f:
                    ln = ln.strip()
                    if ln and not ln.startswith("#") and not ln.startswith("!"):
                        ignored.add(ln)
        except Exception:
            pass
    return ignored


def mask(s: str) -> str:
    """脱敏显示：只留头尾各 3 字符"""
    if len(s) <= 8:
        return s[:2] + "***"
    return s[:4] + "…" + s[-3:]


def scan(root: str):
    findings = []
    gi = load_gitignore(root)
    env_protected = any(x in gi for x in (".env", "*.env"))
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext not in TEXT_EXT and not fn.startswith(".env"):
                continue
            fp = os.path.join(dirpath, fn)
            try:
                with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                    for i, line in enumerate(f, 1):
                        if is_placeholder(line):
                            continue
                        for label, pat in PATTERNS.items():
                            m = pat.search(line)
                            if m:
                                rel = os.path.relpath(fp, root)
                                is_env = fn.startswith(".env") and not fn.endswith(".example")
                                findings.append({
                                    "file": rel, "line": i, "type": label,
                                    "hit": mask(m.group(0)),
                                    "env_protected": is_env and env_protected,
                                })
            except Exception:
                continue
    return findings, env_protected


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    root = os.path.abspath(root)
    print(f"🔍 扫描目录：{root}\n")
    findings, env_protected = scan(root)

    if not findings:
        print("✅ 干净：未检测到任何真实凭据特征，可安全提交。")
        print("   （代码里飞书/百炼凭证均为 env 变量或占位符，无硬编码明文。）")
        sys.exit(0)

    # 区分"已被 gitignore 保护的 .env"和"会被提交的危险泄露"
    danger = [f for f in findings if not f["env_protected"]]
    protected = [f for f in findings if f["env_protected"]]

    if protected:
        print("🟡 以下真实凭据位于 .env，且 .gitignore 已忽略它（不会被提交，安全）：")
        for f in protected:
            print(f"   - {f['file']}:{f['line']}  {f['type']}  {f['hit']}")
        print()

    if danger:
        print("🛑 危险！以下真实凭据出现在【会被提交】的文件里，禁止上传，请立即移除：")
        for f in danger:
            print(f"   - {f['file']}:{f['line']}  {f['type']}  {f['hit']}")
        print("\n处理：把真实值移到 .env（已被忽略），代码里改用 process.env / 占位符。")
        sys.exit(1)

    print("✅ 所有真实凭据都在受保护的 .env 内，可安全提交。")
    sys.exit(0)


if __name__ == "__main__":
    main()
