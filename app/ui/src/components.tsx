import type { CSSProperties, ReactNode } from "react";

/* ---------- icons (24px stroke, currentColor) ---------- */

interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

function svgProps(size: number | undefined, className: string | undefined, style: CSSProperties | undefined) {
  return {
    width: size ?? 18,
    height: size ?? 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    style,
    "aria-hidden": true,
  };
}

export function IconSearch(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

export function IconChart(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </svg>
  );
}

export function IconNetwork(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <circle cx="5" cy="6" r="2.4" />
      <circle cx="19" cy="7" r="2.4" />
      <circle cx="12" cy="18" r="2.4" />
      <path d="M7.3 7 17 6.4M6.6 8 11 16.2M17.4 9 13.2 16.2" />
    </svg>
  );
}

export function IconArchive(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <rect x="3.5" y="4" width="17" height="4.5" rx="1" />
      <path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5" />
      <path d="M10 12h4" />
    </svg>
  );
}

export function IconChat(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.5v-3.5H5.5A1.5 1.5 0 0 1 4 14.5Z" />
      <path d="M8 9h8M8 12.5h5" />
    </svg>
  );
}

export function IconDoc(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <path d="M6 3.5A1.5 1.5 0 0 1 7.5 2h6L18.5 7v12.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6.5 19Z" />
      <path d="M13.5 2v5h5" />
      <path d="M9 12h6M9 15.5h4" />
    </svg>
  );
}

export function IconBulb(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.8.6 1.3 1.3 1.5 2.1h4c.2-.8.7-1.5 1.5-2.1A6 6 0 0 0 12 3Z" />
    </svg>
  );
}

export function IconSpark(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" />
    </svg>
  );
}

export function IconPulse(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
    </svg>
  );
}

export function IconArrow(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

export function IconBook(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <path d="M4 5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Z" />
      <path d="M12 5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2Z" />
    </svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.9" />
    </svg>
  );
}

export function IconWarn(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <path d="M12 4 2.8 20h18.4Z" />
      <path d="M12 10v4M12 16.8v.2" />
    </svg>
  );
}

export function IconClock(p: IconProps) {
  return (
    <svg {...svgProps(p.size, p.className, p.style)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

/* ---------- shared blocks ---------- */

export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string | number;
  tone?: "ok" | "warn" | "danger" | "accent";
  hint?: string;
}) {
  return (
    <div className="stat" title={hint}>
      <div className={`stat-n ${tone ? `tone-${tone}` : ""}`}>{value}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  tone = "accent",
}: {
  icon: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  tone?: "accent" | "ok" | "warn";
}) {
  return (
    <div className="empty-state">
      <div className={`empty-icon tone-${tone}`}>{icon}</div>
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function SectionHeader({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: string;
  right?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div>
        <h2>{title}</h2>
        {sub && <div className="section-sub">{sub}</div>}
      </div>
      {right && <div className="section-right">{right}</div>}
    </div>
  );
}
