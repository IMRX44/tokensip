const file = Array.from({ length: 60 }, (_, i) =>
  i % 9 === 0
    ? `\nexport function handler${i}(req: Request) {`
    : `  const v${i} = await service.compute(${i}, { retries: 3 });`,
).join("\n");
const listing = JSON.stringify(
  {
    files: Array.from({ length: 18 }, (_, i) => ({
      path: `src/modules/feature-${i}/index.ts`,
      size: 1000 + i * 37,
      owners: ["core"],
    })),
  },
  null,
  2,
);

export const SAMPLES = {
  "openai-chat": {
    model: "gpt-4.1",
    messages: [
      {
        role: "system",
        content: "You are a coding agent.   \n\n\n\nRead files before editing them.   \nRun tests after each change.  ",
      },
      { role: "user", content: "The test 'handles empty payload' fails. Fix it." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "list_files", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: listing },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"src/server.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_2", content: file },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_3", type: "function", function: { name: "read_file", arguments: '{"path":"src/server.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_3", content: file },
      { role: "user", content: "Apply the fix." },
    ],
    max_completion_tokens: 8000,
  },
  anthropic: {
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    system: `You are a careful coding agent.\n\n\n\n${"Follow the repository conventions. ".repeat(160)}`,
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
    messages: [
      { role: "user", content: "Find the bug in src/server.ts" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "src/server.ts" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: file }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_2", name: "read_file", input: { path: "src/server.ts" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: file }] },
    ],
  },
  "openai-responses": {
    model: "gpt-5",
    instructions: "You are a helpful assistant.   \n\n\n\nBe concise.",
    reasoning: { effort: "high" },
    input: [
      { role: "user", content: "Summarize the repository layout." },
      { type: "function_call", call_id: "fc_1", name: "list_files", arguments: "{}" },
      { type: "function_call_output", call_id: "fc_1", output: listing },
    ],
  },
  gemini: {
    systemInstruction: { parts: [{ text: "You are a data analyst.   \n\n\n\nAnswer with tables." }] },
    contents: [{ role: "user", parts: [{ text: `Analyze this data:   \n\n\n\n${listing}` }] }],
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 8192 } },
  },
} as const;
