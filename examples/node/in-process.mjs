// Use the TokenSip optimizer inside your own process — no proxy needed.
//   npm install openai @tokensip/core
//   OPENAI_API_KEY=sk-... node in-process.mjs
import { createTokenSipFetch } from "@tokensip/core";
import OpenAI from "openai";

const client = new OpenAI({
  fetch: createTokenSipFetch({
    profile: "balanced",
    onReport: (report) =>
      console.log(`[tokensip] ${report.tokensBefore} → ${report.tokensAfter} tokens in ${report.durationMs} ms`),
  }),
});

const res = await client.chat.completions.create({
  model: "gpt-4.1-mini",
  messages: [
    { role: "system", content: "You are concise.    \n\n\n\n\nAnswer in one sentence.   " },
    { role: "user", content: "What does a token-saving gateway do?" },
  ],
});
console.log(res.choices[0].message.content);
