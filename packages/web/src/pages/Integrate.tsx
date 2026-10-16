import { Bot, Boxes, Cpu } from "lucide-react";
import { useState } from "react";
import { CodeBlock, CopyButton } from "../components/ui";
import { useI18n } from "../i18n";
import { gatewayBase } from "./Providers";

type Snippet = { id: string; label: string; title: string; code: (b: string) => string };

const AGENTS: Snippet[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    title: "shell",
    code: (b) => `# Claude Code talks to the Anthropic API — point it at TokenSip
export ANTHROPIC_BASE_URL="${b}/anthropic"
export ANTHROPIC_API_KEY="tsk_..."   # or keep your own key / login when passthrough is on
claude`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    title: "~/.codex/config.toml",
    code: (b) => `model = "gpt-5"
model_provider = "tokensip"

[model_providers.tokensip]
name = "TokenSip"
base_url = "${b}/openai/v1"
env_key = "TOKENSIP_API_KEY"
wire_api = "responses"`,
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    title: "shell",
    code: (b) => `export GOOGLE_GEMINI_BASE_URL="${b}/google"
export GEMINI_API_KEY="tsk_..."
gemini`,
  },
  {
    id: "aider",
    label: "Aider",
    title: "shell",
    code: (b) => `aider --openai-api-base "${b}/v1" \\
      --openai-api-key "tsk_..." \\
      --model openai/gpt-4.1`,
  },
  {
    id: "cline",
    label: "Cline · Roo · Kilo",
    title: "settings",
    code: (b) => `API Provider : OpenAI Compatible
Base URL     : ${b}/v1
API Key      : tsk_...
Model ID     : claude-sonnet-4-5   # any model — TokenSip routes by name`,
  },
  {
    id: "continue",
    label: "Continue",
    title: "config.yaml",
    code: (b) => `models:
  - name: GPT-4.1 via TokenSip
    provider: openai
    model: gpt-4.1
    apiBase: ${b}/v1
    apiKey: tsk_...`,
  },
];

const SDKS: Snippet[] = [
  {
    id: "py-openai",
    label: "Python · OpenAI",
    title: "python",
    code: (b) => `from openai import OpenAI

client = OpenAI(base_url="${b}/v1", api_key="tsk_...")

# Any model, any provider — routed by name
resp = client.chat.completions.create(
    model="gpt-4.1",            # or "claude-sonnet-4-5", "gemini-2.5-flash", "deepseek-chat" ...
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`,
  },
  {
    id: "py-anthropic",
    label: "Python · Anthropic",
    title: "python",
    code: (b) => `import anthropic

client = anthropic.Anthropic(base_url="${b}/anthropic", api_key="tsk_...")
msg = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)`,
  },
  {
    id: "py-gemini",
    label: "Python · Gemini",
    title: "python",
    code: (b) => `from google import genai
from google.genai import types

client = genai.Client(
    api_key="tsk_...",
    http_options=types.HttpOptions(base_url="${b}/google"),
)
resp = client.models.generate_content(model="gemini-2.5-flash", contents="Hello!")`,
  },
  {
    id: "node",
    label: "Node · OpenAI",
    title: "typescript",
    code: (b) => `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${b}/v1", apiKey: process.env.TOKENSIP_API_KEY });
const res = await client.chat.completions.create({
  model: "gpt-4.1",
  messages: [{ role: "user", content: "Hello!" }],
});`,
  },
  {
    id: "vercel",
    label: "Vercel AI SDK",
    title: "typescript",
    code: (b) => `import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

export const openai = createOpenAI({ baseURL: "${b}/openai/v1", apiKey: process.env.TOKENSIP_API_KEY });
export const anthropic = createAnthropic({ baseURL: "${b}/anthropic/v1", apiKey: process.env.TOKENSIP_API_KEY });`,
  },
  {
    id: "langchain",
    label: "LangChain",
    title: "python",
    code: (b) => `from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4.1", base_url="${b}/v1", api_key="tsk_...")`,
  },
  {
    id: "env",
    label: "Env vars",
    title: ".env",
    code: (b) => `# Most SDKs and tools read these automatically
OPENAI_BASE_URL=${b}/v1
OPENAI_API_KEY=tsk_...
ANTHROPIC_BASE_URL=${b}/anthropic
ANTHROPIC_API_KEY=tsk_...`,
  },
  {
    id: "curl",
    label: "cURL",
    title: "shell",
    code: (b) => `curl ${b}/v1/chat/completions \\
  -H "Authorization: Bearer tsk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Hello!"}]}'`,
  },
];

const INPROCESS = `import OpenAI from "openai";
import { createTokenSipFetch } from "@tokensip/core";

// Optimizes requests inside your process — no proxy, no extra hop.
const client = new OpenAI({
  fetch: createTokenSipFetch({
    profile: "balanced",
    onReport: (r) => console.log(\`saved \${r.tokensSaved} tokens\`),
  }),
});`;

function Tabs({ items, base }: { items: Snippet[]; base: string }) {
  const [active, setActive] = useState(items[0]?.id);
  const cur = items.find((s) => s.id === active) ?? items[0];
  return (
    <>
      <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        {items.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`btn sm ${s.id === cur?.id ? "" : "ghost"}`}
            onClick={() => setActive(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {cur && <CodeBlock title={cur.title} code={cur.code(base)} />}
    </>
  );
}

export function IntegratePage() {
  const { t } = useI18n();
  const base = gatewayBase();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("integrate.title")}</h1>
          <p className="page-sub">{t("integrate.subtitle")}</p>
        </div>
      </div>

      <div className="card hero-card">
        <div className="stat-label">{t("integrate.baseUrl")}</div>
        <div className="row wrap" style={{ marginTop: 8, gap: 16 }}>
          {[
            ["OpenAI-compatible", `${base}/v1`],
            ["Anthropic", `${base}/anthropic`],
            ["Gemini", `${base}/google`],
          ].map(([label, url]) => (
            <div key={label} className="row" style={{ gap: 6 }}>
              <span className="badge">{label}</span>
              <code style={{ fontSize: 14 }}>{url}</code>
              <CopyButton text={url as string} />
            </div>
          ))}
        </div>
        <p className="small faint" style={{ margin: "12px 0 0" }}>
          {t("integrate.keyHint")}
        </p>
      </div>

      <div className="grid grid-2 mt">
        <div className="card">
          <h3 className="card-title">
            <Bot size={16} /> {t("integrate.agents")}
          </h3>
          <Tabs items={AGENTS} base={base} />
        </div>
        <div className="card">
          <h3 className="card-title">
            <Boxes size={16} /> {t("integrate.sdks")}
          </h3>
          <Tabs items={SDKS} base={base} />
        </div>
      </div>

      <div className="grid grid-2 mt">
        <div className="card">
          <h3 className="card-title">
            <Cpu size={16} /> {t("integrate.inprocess")}
          </h3>
          <p className="card-sub">{t("integrate.inprocessBody")}</p>
          <CodeBlock title="typescript" code={INPROCESS} />
        </div>
        <div className="card">
          <h3 className="card-title">{t("integrate.headers")}</h3>
          <p className="card-sub">{t("integrate.headersBody")}</p>
          <table className="table">
            <tbody>
              {[
                ["x-tokensip-profile", "off | safe | balanced | aggressive | extreme"],
                ["x-tokensip-cache", "bypass | force"],
                ["x-tokensip-provider", "openai | anthropic | groq | …"],
              ].map(([h, v]) => (
                <tr key={h}>
                  <td>
                    <code>{h}</code>
                  </td>
                  <td className="faint mono small">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small faint" style={{ marginBottom: 0 }}>
            ↩ <code>x-tokensip-request-id</code> · <code>x-tokensip-tokens-saved</code> · <code>x-tokensip-cache</code>{" "}
            · <code>x-tokensip-warning</code>
          </p>
        </div>
      </div>
    </div>
  );
}
