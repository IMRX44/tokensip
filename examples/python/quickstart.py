"""TokenSip quickstart — the only change is `base_url`.

    pip install openai anthropic
    npx tokensip            # in another terminal
    export TOKENSIP_API_KEY=tsk_...   # or your own provider key when passthrough is on
    python quickstart.py
"""

import os

import anthropic
from openai import OpenAI

BASE = os.environ.get("TOKENSIP_URL", "http://localhost:8787")
KEY = os.environ["TOKENSIP_API_KEY"]

# One OpenAI-compatible endpoint for every provider — TokenSip routes by model name.
openai_client = OpenAI(base_url=f"{BASE}/v1", api_key=KEY)
for model in ["gpt-4.1-mini", "gemini-2.5-flash", "deepseek-chat"]:
    raw = openai_client.chat.completions.with_raw_response.create(
        model=model,
        messages=[{"role": "user", "content": "Say hi in five words."}],
    )
    reply = raw.parse()
    print(f"{model:>20}: {reply.choices[0].message.content!r}  "
          f"(saved {raw.headers.get('x-tokensip-tokens-saved', '0')} tokens, "
          f"cache {raw.headers.get('x-tokensip-cache')})")

# Native Anthropic API — prompt-cache breakpoints are added automatically.
claude = anthropic.Anthropic(base_url=f"{BASE}/anthropic", api_key=KEY)
msg = claude.messages.create(
    model="claude-haiku-4-5",
    max_tokens=200,
    messages=[{"role": "user", "content": "Say hi in five words."}],
)
print(f"{'claude-haiku-4-5':>20}: {msg.content[0].text!r}")
