export interface BrandMarkProps {
  /** Diameter in px. */
  size?: number;
}

/** The Club70 circled-seven mark, drawn in the accent lime. */
export function BrandMark({ size = 48 }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-label="Club70"
    >
      <circle cx="36" cy="24" r="16" stroke="var(--color-accent)" strokeWidth="2.5" />
      <path
        d="M18 24 H 52 L 24 58"
        stroke="var(--color-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
