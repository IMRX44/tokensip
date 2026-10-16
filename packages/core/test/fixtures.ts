const bigJson = JSON.stringify(
  {
    items: Array.from({ length: 60 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      tags: ["a", "b"],
      big: 12345678901234567890n.toString(),
    })),
  },
  null,
  2,
);
export const BIG_JSON = bigJson;
export const LONG_FILE = Array.from(
  { length: 400 },
  (_, i) => `export const value${i} = computeSomething(${i}); // line ${i}`,
).join("\n");

/** An agent-style OpenAI conversation: system, task, several tool steps. */
export function openaiAgentConversation() {
  return {
    model: "gpt-4.1",
    messages: [
      {
        role: "system",
        content: "You are a coding agent.   \n\n\n\nFollow the rules.  ",
      },
      { role: "user", content: "Fix the failing test in src/app.ts" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read", arguments: '{"path":"src/app.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: LONG_FILE },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c2",
            type: "function",
            function: { name: "list", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c2", content: BIG_JSON },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c3",
            type: "function",
            function: { name: "read", arguments: '{"path":"src/app.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c3", content: LONG_FILE },
      { role: "assistant", content: "I found the bug." },
      { role: "user", content: "Great, now apply the fix." },
    ],
    tools: [
      {
        type: "function",
        function: { name: "read", parameters: { type: "object" } },
      },
    ],
  };
}

export function anthropicConversation() {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    system: `You are helpful.\n${"Rules. ".repeat(900)}`,
    tools: [
      {
        name: "read",
        description: "read a file",
        input_schema: { type: "object" },
      },
    ],
    messages: [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "tool_use", id: "t1", name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: LONG_FILE }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done   \n\n\n\n" }],
      },
      { role: "user", content: "Thanks" },
    ],
  };
}
