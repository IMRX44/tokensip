<div align="center">

<img src="assets/banner.svg" alt="TokenSip" width="100%" />

<h3>降低大模型账单，而不改变 AI 的行为。</h3>

[English](README.md) · [فارسی](README.fa.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · **简体中文**

</div>

**TokenSip** 是一个开源、可自托管的 AI 网关，位于你的应用与 **OpenAI、Anthropic、Gemini、DeepSeek 等 20 多家服务商**之间：最大化提示词缓存命中、去除浪费的 Token，并清楚展示省下的每一分钱。

<img src="assets/screenshots/overview-zh-light.png" alt="TokenSip 中文控制台" width="100%" />

## 为什么选择 TokenSip？

编程智能体和聊天应用**每一轮都会重新发送整个对话**。只要正确使用提示词缓存，服务商只按**正常价格的 10%–50%** 收取这些重复上下文的费用——但大多数应用并没有这样做。TokenSip 会自动完成：

- 🧠 **为缓存而设计**：自动添加 Anthropic `cache_control` 断点和稳定的 OpenAI `prompt_cache_key`。所有优化都保持前缀稳定，缓存每一轮都能命中。
- 🪶 **对智能体安全**：默认的 `balanced` 配置绝不删除模型仍需要的内容：每个文件和命令输出的最新版本都完整保留，助手回复从不改动；`safe` 则将未改动的请求**逐字节**原样转发。
- 🎚️ **由你决定取舍**：从 `off` 到 `extreme`（约为原始提示词的 10%）共五档，并对质量影响给出明确警告。
- 🔌 **无需改代码**：只需替换 Base URL。兼容所有 SDK，以及 Claude Code、Codex、Gemini CLI、Aider、Cline 等。
- 🔐 **安全私密**：加密密钥库、带预算的虚拟密钥、不存储提示词、双因素认证、严格 CSP。

## 🧠 2.0 新功能：懂缓存经济学的上下文引擎

所有上下文管理工具都在让提示词*变短*。但在提示词缓存下，这往往是**亏本**的：命中缓存的 Token 只收 10% 的价格，删除长会话开头的一段过时输出，会迫使服务商把它之后的所有内容重新处理，并以 125% 的价格重新写入缓存。在我们的模拟中，每轮都裁剪比普通缓存**贵 33%–87%**。而凭猜测裁剪还会删掉智能体仍然需要的代码。

TokenSip 2 改问两个更精确的问题：

1. **这条信息是否可证明已经过时？** 文件被重新读取、测试被重新运行——更新的结果才反映当前状态。只有旧副本会被替换为指向新调用的指针；最新的观察结果始终完整保留，智能体无需重新读取或重做。
2. **现在删除是否比保留更便宜？** 由服务商缓存的影子模型来决定：缓存已冷、或重写能够回本时（`S·r·H ≥ (C−p)·(w−r)`）立即执行，否则等待免费的时机。已执行的修改保持不变，下一轮起前缀即可再次命中缓存。

**Cache Doctor** 会找出悄悄破坏缓存的值——系统提示词中的时钟或请求 ID、每次顺序不同的工具列表——并在不对模型隐藏任何信息的前提下自动修复。

| 相同的 720 轮智能体对话，按 Anthropic 缓存规则计费 | 普通缓存 | 每轮裁剪 | **TokenSip 2** |
| --- | --- | --- | --- |
| 空闲超过 5 分钟缓存有效期 | $33.00 | $43.85 (+32.9%) | **$22.82 (−30.9%)** |
| 系统提示词中带时钟 | $161.96 | $46.41 (−71.3%) | **$23.86 (−85.3%)** |
| 无空闲 | $20.77 | $38.87 (+87.2%) | **$18.72 (−9.9%)** |

自己运行：`npx tokensip simulate`。在真实服务商上，带时钟的系统提示词从缓存读取的比例从**约 6% 提升到约 96%**。[设计详解（英文）](docs/cache-economics.md)

<img src="assets/screenshots/sessions.png" alt="会话：每一轮从缓存读取的提示词 Token" width="100%" />

## 🚀 快速开始

```bash
npx tokensip
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="sk-...")
client.chat.completions.create(model="qwen-plus", messages=[...])  # 自动路由到通义千问
```

```bash
# Docker
docker run -d -p 127.0.0.1:8787:8787 -e TOKENSIP_SECRET="$(openssl rand -hex 32)" \
  -v tokensip-data:/data ghcr.io/imrx44/tokensip:latest

# 使用模拟数据体验控制台（密码：tokensip-demo）
npx tokensip demo
```

## 🎚️ 节省配置

| 配置 | 发送的提示词 | 质量风险 | 作用 |
| --- | --- | --- | --- |
| `off` | 100% | 无 | 纯代理：分析、预算、响应缓存 |
| `safe` | 95–100% | **无** | 缓存断点、缓存路由键、稳定工具顺序、清理空白 |
| **`balanced`**（默认） | 70–95% | 低 | + Cache Doctor 修复、按缓存经济学删除过时工具输出、工具结果去重 |
| `aggressive` ⚠️ | 40–70% | 中 | + 压缩 JSON、截断过时工具输出、对话窗口 |
| `extreme` ⚠️ | **约 10%** | **高** | + 上下文预算、降低推理强度、限制输出长度 |

在 `examples/requests` 中的智能体示例上实测：`balanced` 减少约 **42%**，`extreme` 减少 **89%–91%** 的提示词 Token。

## 🔌 端点

| 服务商 | Base URL |
| --- | --- |
| 全部（按模型名自动路由） | `http://localhost:8787/v1` |
| OpenAI | `http://localhost:8787/openai/v1` |
| Anthropic | `http://localhost:8787/anthropic` |
| Google Gemini | `http://localhost:8787/google` |
| DeepSeek · 通义千问 (qwen) · Kimi (moonshot) · 智谱 GLM (zai) | `http://localhost:8787/<provider>/v1` |
| Ollama · LM Studio · vLLM（本地） | `http://localhost:8787/ollama/v1` |

## 🔐 安全

- 服务商密钥与响应缓存使用 AES-256-GCM 加密
- 虚拟密钥（`tsk_…`）支持月度预算、限流与过期时间
- 不存储提示词和回复——仅记录元数据
- 一次性设置令牌、scrypt、双因素认证、CSRF 防护、审计日志

详见 [SECURITY.md](SECURITY.md) 与 [文档](docs)。

## 📄 许可证

[MIT](LICENSE) —— 如果 TokenSip 帮你省了钱，请给仓库点个 **⭐**。
