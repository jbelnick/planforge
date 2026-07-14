import type { SVGProps } from "react";

// A tiny inline icon set for the PlanForge chat pane. No icon dependency.
//
// Discipline (per the design-taste-frontend / emil-design-eng skills):
// - Functional glyphs only (trash, edit, chevron, menu, close, archive, restore), never hand-drawn
//   decorative illustrations.
// - One family: outline icons, stroke-width 1.5, `currentColor` so they inherit the button text
//   color, on a 24px viewbox scaled by the consumer via the inherited font-size / width+height.
// - aria-hidden: these are presentational; the actionable label always comes from the wrapping
//   button's accessible name, so a screen reader never announces the glyph itself.
//
// Each icon accepts the standard SVG props so callers can set className/width/height as needed.

const BASE = 1.5;

function IconShell(props: SVGProps<SVGSVGElement>) {
  return {
    width: "1em",
    height: "1em",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: BASE,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
    ...props
  };
}

export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...IconShell(props)}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export function PencilIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...IconShell(props)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

export function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...IconShell(props)}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function MenuIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...IconShell(props)}>
      <path d="M3 6h18" />
      <path d="M3 12h18" />
      <path d="M3 18h18" />
    </svg>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...IconShell(props)}>
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

export function ArchiveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...IconShell(props)}>
      <path d="M3 5h18v4H3z" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
      <path d="M10 13h4" />
    </svg>
  );
}

export function RestoreIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...IconShell(props)}>
      <path d="M9 14l-5-5 5-5" />
      <path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9" />
    </svg>
  );
}

// Collapse/expand all entries: two stacked rows with vertical edges, the bottom row shortened to
// read as "folded" content. Pairs with the toggle's expand/collapse label.
export function CollapseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...IconShell(props)}>
      <path d="M4 9h16" />
      <path d="M4 13h16" />
      <path d="M4 17h9" />
    </svg>
  );
}

// Timeline: a vertical spine with three stacked nodes — the single-lane chronological view.
export function TimelineIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...IconShell(props)}>
      <path d="M8 3v18" />
      <path d="M6 6h2" />
      <path d="M6 12h2" />
      <path d="M6 18h2" />
      <path d="M12 6h8" />
      <path d="M12 12h8" />
      <path d="M12 18h8" />
    </svg>
  );
}

// Split lanes: two parallel columns side by side — the architect/builder two-lane view.
export function SplitIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...IconShell(props)}>
      <path d="M12 3v18" />
      <path d="M4 8h5" />
      <path d="M4 13h5" />
      <path d="M15 8h5" />
      <path d="M15 13h5" />
    </svg>
  );
}
