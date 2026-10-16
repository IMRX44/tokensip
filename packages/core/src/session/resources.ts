/**
 * Resource identity for tool observations: two observations with the same
 * resource key describe the same thing (a file, a command's output, a query),
 * so the newer one makes the older one outdated.
 */

export type ResourceKind = "file" | "command" | "query";

export interface Resource {
  kind: ResourceKind;
  /** Stable identity; includes ranges for partial reads. */
  key: string;
  /** File key without range, for partial-vs-full comparisons. */
  fileKey?: string;
  /** True for partial reads (line ranges, head/tail). */
  partial: boolean;
  /** Short human label for tombstones. */
  label: string;
}

const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "file",
  "filename",
  "target_file",
  "absolute_path",
  "notebook_path",
  "uri",
];
const RANGE_KEYS = [
  "offset",
  "limit",
  "start_line",
  "end_line",
  "line_start",
  "line_end",
  "startLine",
  "endLine",
  "view_range",
  "lines",
  "range",
  "head",
  "tail",
  "max_lines",
];
const COMMAND_KEYS = ["command", "cmd", "script"];

/** Tools that change the world. Their results are records of actions, never "outdated observations". */
const MUTATING_NAME =
  /(write|edit|patch|create|delete|remove|move|rename|insert|replace|update|apply|commit|push|install|upload|send|post|todo|memory|notebook_edit|mkdir)/i;
const READ_NAME = /(read|view|cat|open|file|get_file|show)/i;
const QUERY_NAME = /(grep|glob|search|find|list|ls\b|query|lookup|fetch|get|describe|show|status|inspect)/i;
const SHELL_NAME =
  /^(bash|shell|sh|exec|terminal|run_command|run_terminal_cmd|execute_command|local_shell|run_shell_command)$/i;

/**
 * Commands whose output is an observation of state (re-running them is safe and
 * makes the earlier output outdated). Anything else is treated as an action.
 */
const OBSERVATIONAL_COMMAND = new RegExp(
  [
    "^(ls|ll|tree|pwd|find|fd|wc|du|stat|file|which|env|printenv)(\\s|$)",
    "^(grep|rg|ag|ack)\\s",
    "^git\\s+(status|diff|log|show|branch|ls-files|blame)(\\s|$)",
    "^(npm|pnpm|yarn|bun)\\s+(test|t|run\\s+(test|lint|typecheck|check|build|tsc))(\\s|$)",
    "^(npx\\s+)?(tsc|eslint|biome|prettier\\s+--check|vitest\\s+run|jest|mocha)(\\s|$)",
    "^(python3?\\s+-m\\s+)?(pytest|mypy|ruff|flake8|pylint)(\\s|$)",
    "^go\\s+(test|vet|build)(\\s|$)",
    "^cargo\\s+(test|check|build|clippy)(\\s|$)",
    "^(make|just)\\s+(test|check|lint)(\\s|$)",
    "^(docker|kubectl)\\s+(ps|get|logs|describe)(\\s|$)",
  ].join("|"),
);

function normPath(p: string): string {
  return p
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

function normCommand(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim().replace(/\s+/g, " ");
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    const parts = raw as string[];
    // ["bash", "-lc", "<script>"] → the script
    if (parts.length >= 3 && /^(ba|z)?sh$/.test(parts[0]?.split("/").pop() ?? "") && /^-l?c$/.test(parts[1] ?? "")) {
      return (parts.slice(2).join(" ") || "").trim().replace(/\s+/g, " ");
    }
    return parts.join(" ").trim().replace(/\s+/g, " ");
  }
  return undefined;
}

function short(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Recognize pure file reads expressed as shell commands (cat/head/tail/sed -n/nl). */
function shellFileRead(cmd: string): { path: string; partial: boolean; range: string } | undefined {
  let m = /^cat\s+(?:-n\s+)?(['"]?)([^\s'"|;&<>]+)\1$/.exec(cmd);
  if (m?.[2]) return { path: m[2], partial: false, range: "" };
  m = /^nl\s+-ba\s+(['"]?)([^\s'"|;&<>]+)\1$/.exec(cmd);
  if (m?.[2]) return { path: m[2], partial: false, range: "" };
  m = /^(head|tail)\s+(-n\s*\d+|-\d+)\s+(['"]?)([^\s'"|;&<>]+)\3$/.exec(cmd);
  if (m?.[4]) return { path: m[4], partial: true, range: `${m[1]}${m[2]}` };
  m = /^sed\s+-n\s+(['"]?)(\d+,\d+p)\1\s+(['"]?)([^\s'"|;&<>]+)\3$/.exec(cmd);
  if (m?.[4] && m[2]) return { path: m[4], partial: true, range: m[2] };
  return undefined;
}

export function resourceOf(name: string, args: unknown): Resource | undefined {
  const obj = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
  if (!obj) return undefined;

  // Shell commands: only observational ones count; file reads map to the file resource.
  const cmdKey = COMMAND_KEYS.find((k) => obj[k] !== undefined);
  if (cmdKey && (SHELL_NAME.test(name) || !MUTATING_NAME.test(name))) {
    const cmd = normCommand(obj[cmdKey]);
    if (!cmd || /[;&|>]|\$\(|`/.test(cmd.replace(/\s2>&1$/, ""))) return undefined; // pipelines and redirections may have side effects
    const cwd = typeof obj.workdir === "string" ? obj.workdir : typeof obj.cwd === "string" ? obj.cwd : "";
    const read = shellFileRead(cmd);
    if (read) {
      const path = normPath(cwd && !read.path.startsWith("/") ? `${cwd}/${read.path}` : read.path);
      return {
        kind: "file",
        key: `file:${path}${read.partial ? `#${read.range}` : ""}`,
        fileKey: `file:${path}`,
        partial: read.partial,
        label: path,
      };
    }
    if (!OBSERVATIONAL_COMMAND.test(cmd)) return undefined;
    return { kind: "command", key: `cmd:${cwd}|${cmd}`, partial: false, label: short(cmd) };
  }

  if (MUTATING_NAME.test(name)) return undefined;

  const pathKey = PATH_KEYS.find((k) => typeof obj[k] === "string" && (obj[k] as string).length > 0);
  if (pathKey && READ_NAME.test(name)) {
    const path = normPath(obj[pathKey] as string);
    const rangeParts = RANGE_KEYS.filter((k) => obj[k] !== undefined && obj[k] !== null).map(
      (k) => `${k}=${JSON.stringify(obj[k])}`,
    );
    const partial = rangeParts.length > 0;
    return {
      kind: "file",
      key: `file:${path}${partial ? `#${rangeParts.join("&")}` : ""}`,
      fileKey: `file:${path}`,
      partial,
      label: path,
    };
  }

  if (QUERY_NAME.test(name)) {
    const keys = Object.keys(obj).sort();
    const canon = JSON.stringify(keys.map((k) => [k, obj[k]]));
    return { kind: "query", key: `call:${name}:${canon}`, partial: false, label: `${name} ${short(canon, 50)}` };
  }
  return undefined;
}
