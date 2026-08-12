export interface BrandMarkProps {
  /** Rendered height in px. The mark keeps its 4:5 aspect ratio. */
  size?: number;
  className?: string;
}

/**
 * The Club70 "7" mark (horizontal bar + diagonal stem with a ring at the top
 * right), taken verbatim from the Figma logo. Drawn in the current text color
 * so callers set the tone (the accent lime on dark, per the brand).
 */
export function BrandMark({ size = 40, className }: BrandMarkProps) {
  return (
    <svg
      width={size * 0.8}
      height={size}
      viewBox="0 0 80 100"
      fill="none"
      role="img"
      aria-label="Club70"
      className={className}
    >
      <path d="M48.6451 31.7073H52.5917L14.6671 100H10.7206L48.6451 31.7073Z" fill="currentColor" />
      <path d="M0 31.7073V34.9381H50.0832V31.7073H0Z" fill="currentColor" />
      <path
        d="M76.6233 31.6057C76.6233 16.0242 64.0527 3.393 48.5461 3.393C33.0396 3.39302 20.469 16.0243 20.469 31.6057C20.469 47.1871 33.0396 59.8184 48.5461 59.8184V63.2114L48.3428 63.2107C31.1327 63.1012 17.2019 49.1034 17.0929 31.8102L17.0923 31.6057C17.0923 14.1504 31.1747 1.73259e-05 48.5461 0L48.7497 0.000631139C66.0275 0.110613 80 14.2185 80 31.6057L79.9994 31.8102C79.8899 49.1714 65.8498 63.2114 48.5461 63.2114V59.8184C64.0527 59.8184 76.6233 47.1871 76.6233 31.6057Z"
        fill="currentColor"
      />
    </svg>
  );
}
