import { useRef } from 'react';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
}

export interface SegmentedControlProps<Value extends string> {
  /** Announced name of the group, e.g. "Billing interval". */
  label: string;
  options: readonly SegmentedOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
}

/**
 * Pill segmented control (the Figma "Tabs" on choose-membership). Radio
 * group semantics with roving tabindex: Tab reaches the group once,
 * arrow keys move the selection.
 */
export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
}: SegmentedControlProps<Value>) {
  const groupRef = useRef<HTMLDivElement>(null);

  function moveSelection(offset: number) {
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + offset + options.length) % options.length];
    onChange(next.value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.[options.indexOf(next)]?.focus();
  }

  return (
    <div ref={groupRef} className={styles.group} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={[styles.segment, selected ? styles.selected : ''].join(' ')}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                moveSelection(1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveSelection(-1);
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
