import { useId } from "react";

export function Logo({ size = 32 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#34E2A1" />
          <stop offset="1" stopColor="#3EC5FF" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="#0B1118" stroke="rgba(148,178,210,.18)" />
      <path d="M38 8 L38 20 M38 20 L44 14" stroke={`url(#${id})`} strokeWidth="4" strokeLinecap="round" fill="none" />
      <path d="M32 20c0 0-13 14.5-13 23a13 13 0 0 0 26 0c0-8.5-13-23-13-23z" fill={`url(#${id})`} />
      <path
        d="M26 44a6 6 0 0 0 6 6"
        stroke="#0B1118"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
        opacity=".55"
      />
    </svg>
  );
}
