// Minimal OpenAI-compatible mock provider used by scripts/bench.mjs.
import { createServer } from "node:http";

const reply = JSON.stringify({
  id: "x",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 14000, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 12000 } },
});
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(reply);
  });
});
server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});
