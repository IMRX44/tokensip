const PALETTE = ["#34E2A1", "#3EC5FF", "#9B8CFF", "#FFB547", "#FF8A65", "#5EEAD4", "#F472B6", "#A3E635"];

export function brandColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length] as string;
}

export function initials(name: string): string {
  const parts = name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}
