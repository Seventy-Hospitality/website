import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarX2 } from 'lucide-react';
import type { ResourceTypeSummary } from '../../lib/api';
import {
  buildDateStrip,
  formatSlotRange,
  formatStripDay,
  pruneSelection,
  resourceNoun,
  timeLabelToMinutes,
  todayDateKey,
  toggleSlot,
} from '../../lib/booking';
import { Button, EmptyState, Skeleton } from '../../components';
import { availabilityQuery } from './booking-data';
import styles from './wizard.module.css';

/** Days shown before "More dates" expands the strip to the full horizon. */
const INITIAL_STRIP_DAYS = 7;

export interface SelectTimeStepProps {
  headingRef: Ref<HTMLHeadingElement>;
  type: ResourceTypeSummary;
  date: string;
  onDateChange: (date: string) => void;
  slots: string[];
  onSlotsChange: (slots: string[]) => void;
  notice: string | null;
  onDismissNotice: () => void;
  onContinue: () => void;
  /** Heading override ("Edit booking" in W4's reschedule wizard). */
  title?: string;
  /**
   * Slots treated as bookable on top of the fetched availability, for the
   * CURRENT date. W4's edit wizard passes the reservation's own slots: the
   * availability endpoint reads its claim as taken, but to itself it is
   * free (the backend reschedule self-excludes it).
   */
  extraAvailable?: string[];
  continueLabel?: string;
  /** Extra gating on top of "at least one slot" (W4's dirty check). */
  continueDisabled?: boolean;
}

/**
 * Wizard step 1 (Figma select-time 286:8257 / 325:14701): horizontal date
 * strip with "More dates", then the 30-minute SELECT SLOTS list showing
 * only bookable times (taken times are simply absent, no disabled rows).
 * Multi-select keeps the run contiguous; Continue needs at least one slot.
 */
export function SelectTimeStep({
  headingRef,
  type,
  date,
  onDateChange,
  slots,
  onSlotsChange,
  notice,
  onDismissNotice,
  onContinue,
  title,
  extraAvailable,
  continueLabel = 'Continue',
  continueDisabled = false,
}: SelectTimeStepProps) {
  const strip = useMemo(
    () => buildDateStrip(todayDateKey(), type.maxAdvanceDays),
    [type.maxAdvanceDays],
  );
  const [expanded, setExpanded] = useState(() => strip.indexOf(date) >= INITIAL_STRIP_DAYS);
  const visibleStrip = expanded ? strip : strip.slice(0, INITIAL_STRIP_DAYS);

  const availability = useQuery(availabilityQuery(type.code, date));
  const day = availability.data?.[0];
  const available = useMemo(() => {
    const fetched = day?.slots.map((slot) => slot.start) ?? [];
    if (!extraAvailable || extraAvailable.length === 0) return fetched;
    const merged = new Set(fetched);
    for (const slot of extraAvailable) merged.add(slot);
    return [...merged].sort((a, b) => timeLabelToMinutes(a) - timeLabelToMinutes(b));
  }, [day, extraAvailable]);

  // An availability refetch can remove a selected slot (someone else booked
  // it); prune so the selection never holds a time we cannot book.
  useEffect(() => {
    if (!availability.isSuccess) return;
    const availableSet = new Set(available);
    if (slots.every((slot) => availableSet.has(slot))) return;
    onSlotsChange(pruneSelection(slots, available, type.slotDurationMinutes));
  }, [availability.isSuccess, available, slots, onSlotsChange, type.slotDurationMinutes]);

  return (
    <div className={styles.step}>
      <h1 ref={headingRef} tabIndex={-1} className={styles.stepTitle}>
        {title ?? `Book a ${resourceNoun(type.name)}`}
      </h1>

      {notice && (
        <div className={styles.noticeBox} role="alert">
          <p>{notice}</p>
          <Button variant="secondary" size="sm" onClick={onDismissNotice}>
            Dismiss
          </Button>
        </div>
      )}

      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel} id="select-date-label">
          Select date
        </span>
        {!expanded && strip.length > INITIAL_STRIP_DAYS && (
          <button
            type="button"
            className={styles.sectionLink}
            onClick={() => setExpanded(true)}
          >
            More dates
          </button>
        )}
      </div>

      <DateStrip
        dates={visibleStrip}
        value={date}
        onChange={(next) => {
          onDismissNotice();
          onDateChange(next);
        }}
      />

      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel} id="select-slots-label">
          Select slots
        </span>
      </div>

      {availability.isPending ? (
        <div className={styles.slotList} aria-busy="true" role="status">
          <span className="visually-hidden">Loading available times</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height="3.25rem" shape="card" />
          ))}
        </div>
      ) : availability.isError ? (
        <div className={styles.errorBox} role="alert">
          <p>We could not load the available times.</p>
          <Button variant="secondary" size="sm" onClick={() => void availability.refetch()}>
            Try again
          </Button>
        </div>
      ) : available.length === 0 ? (
        <EmptyState
          icon={<CalendarX2 aria-hidden />}
          title="No available times"
          description="This day is fully booked. Try another date."
        />
      ) : (
        <SlotList
          slots={available}
          slotDurationMinutes={type.slotDurationMinutes}
          selected={slots}
          onToggle={(slot) => {
            onDismissNotice();
            onSlotsChange(toggleSlot(slots, slot, type.slotDurationMinutes));
          }}
        />
      )}

      <div className={styles.stepFooter}>
        <Button fullWidth disabled={slots.length === 0 || continueDisabled} onClick={onContinue}>
          {continueLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Horizontal date strip: radio-group semantics with roving tabindex
 * (SegmentedControl is the kit reference), Left/Right arrows move and
 * select.
 */
function DateStrip({
  dates,
  value,
  onChange,
}: {
  dates: string[];
  value: string;
  onChange: (date: string) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);

  function move(offset: number) {
    const index = dates.indexOf(value);
    const next = dates[Math.min(dates.length - 1, Math.max(0, index + offset))];
    if (next === undefined || next === value) return;
    onChange(next);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.[dates.indexOf(next)]?.focus();
  }

  return (
    <div
      ref={groupRef}
      className={styles.dateStrip}
      role="radiogroup"
      aria-labelledby="select-date-label"
    >
      {dates.map((key) => {
        const parts = formatStripDay(key);
        const selected = key === value;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={[styles.dateTile, selected ? styles.dateTileSelected : ''].join(' ')}
            onClick={() => onChange(key)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                move(1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(-1);
              }
            }}
          >
            <span className={styles.dateTileWeekday}>{parts.weekday}</span>
            <span className={styles.dateTileDay}>{parts.day}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The bookable slot list: a multi-selectable listbox with roving tabindex.
 * Arrow keys move the active option, Space/Enter toggles it. Only bookable
 * slots are rendered, so there is no disabled styling to manage.
 */
function SlotList({
  slots,
  slotDurationMinutes,
  selected,
  onToggle,
}: {
  slots: string[];
  slotDurationMinutes: number;
  selected: string[];
  onToggle: (slot: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const active = Math.min(activeIndex, slots.length - 1);
  const selectedSet = new Set(selected);

  function focusOption(index: number) {
    const clamped = Math.min(slots.length - 1, Math.max(0, index));
    setActiveIndex(clamped);
    const options = listRef.current?.querySelectorAll<HTMLButtonElement>('button');
    options?.[clamped]?.focus();
  }

  return (
    <div
      ref={listRef}
      className={styles.slotList}
      role="listbox"
      aria-labelledby="select-slots-label"
      aria-multiselectable="true"
    >
      {slots.map((slot, index) => {
        const isSelected = selectedSet.has(slot);
        return (
          <button
            key={slot}
            type="button"
            role="option"
            aria-selected={isSelected}
            tabIndex={index === active ? 0 : -1}
            className={[styles.slotOption, isSelected ? styles.slotOptionSelected : ''].join(' ')}
            onClick={() => {
              setActiveIndex(index);
              onToggle(slot);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                event.preventDefault();
                focusOption(index + 1);
              } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                event.preventDefault();
                focusOption(index - 1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                focusOption(0);
              } else if (event.key === 'End') {
                event.preventDefault();
                focusOption(slots.length - 1);
              }
            }}
          >
            {formatSlotRange(slot, slotDurationMinutes)}
          </button>
        );
      })}
    </div>
  );
}
