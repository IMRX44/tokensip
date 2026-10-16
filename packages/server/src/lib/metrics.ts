type Labels = Record<string, string>;

/** Minimal Prometheus counters — no client library needed. */
export class Metrics {
  private readonly counters = new Map<string, { help: string; values: Map<string, number> }>();

  constructor() {
    this.define("tokensip_requests_total", "Proxied requests");
    this.define("tokensip_prompt_tokens_total", "Prompt tokens billed by providers (incl. cache reads/writes)");
    this.define("tokensip_output_tokens_total", "Output tokens billed by providers");
    this.define("tokensip_tokens_trimmed_total", "Prompt tokens removed by TokenSip optimizers");
    this.define("tokensip_cache_read_tokens_total", "Prompt tokens served from provider prompt caches");
    this.define("tokensip_response_cache_hits_total", "Responses served from the TokenSip response cache");
    this.define("tokensip_cost_usd_total", "Actual cost in USD");
    this.define("tokensip_baseline_cost_usd_total", "Cost in USD without TokenSip and prompt caching");
  }

  private define(name: string, help: string): void {
    this.counters.set(name, { help, values: new Map() });
  }

  inc(name: string, labels: Labels, by = 1): void {
    const c = this.counters.get(name);
    if (!c || !by) return;
    const key = Object.entries(labels)
      .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`)
      .join(",");
    c.values.set(key, (c.values.get(key) ?? 0) + by);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, c] of this.counters) {
      lines.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [labels, v] of c.values) lines.push(`${name}${labels ? `{${labels}}` : ""} ${v}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
