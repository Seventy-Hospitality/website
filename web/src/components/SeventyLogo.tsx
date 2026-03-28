import type { CSSProperties } from 'react';

type SeventyLogoProps = {
  size?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
};

export function SeventyLogo({
  size = 32,
  color = 'rgb(61, 83, 65)',
  className,
  style,
}: SeventyLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 90 108"
      fill="none"
      className={className}
      style={style}
      aria-label="Seventy"
    >
      <defs>
        <clipPath id="seventy-clip">
          <rect x="0" y="0" width="90" height="105" />
        </clipPath>
      </defs>
      <circle cx="56" cy="36" r="30" stroke={color} strokeWidth="9" fill="none" />
      <path
        d="M 8,36 L 56,36 L 20,105"
        stroke={color}
        strokeWidth="9"
        strokeLinejoin="miter"
        strokeLinecap="square"
        fill="none"
        clipPath="url(#seventy-clip)"
      />
    </svg>
  );
}
