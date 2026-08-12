import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ResourceTypeSummary } from '../../lib/api';
import { EmptyStateView, PrimaryButton, Skeleton } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import {
  buildDateStrip,
  formatStripDay,
  pruneSelection,
  resourceNoun,
  todayDateKey,
  toggleSlot,
} from './booking';
import { availabilityQuery } from './booking-data';
import { SlotPill } from './SlotPill';
import { StepShell } from './StepShell';

/** Days shown before "More dates" expands the strip to the full horizon. */
const INITIAL_STRIP_DAYS = 7;

export interface SelectTimeStepProps {
  type: ResourceTypeSummary;
  /** The venue IANA zone; the strip's "today" anchor. */
  timezone: string;
  date: string;
  onDateChange: (date: string) => void;
  slots: string[];
  onSlotsChange: (slots: string[]) => void;
  /** Alert shown after a failure bounced the user back to this step. */
  notice: string | null;
  onDismissNotice: () => void;
  onContinue: () => void;
  /** Step title; defaults to the booking "Book a court" heading. */
  title?: string;
  /** Footer label; defaults to "Continue". */
  continueLabel?: string;
  /**
   * Extra gate on Continue on top of "needs a slot" (M4 edit's dirty check:
   * Continue stays disabled until the selection actually changes).
   */
  continueDisabled?: boolean;
  /**
   * M4 edit/reschedule: exclude this reservation's own claim from availability
   * so its current slots read as bookable to itself (backend self-exclusion).
   */
  excludeReservationId?: string;
}

/**
 * Wizard step 1 (Figma select-time 286:8257 / 325:14701): a horizontal date
 * strip with "More dates", then the 30-minute slot list showing only
 * bookable times (taken times are simply absent). Multi-select keeps the run
 * contiguous; Continue needs at least one slot. Mirrors member-web's
 * SelectTimeStep, native.
 */
export function SelectTimeStep({
  type,
  timezone,
  date,
  onDateChange,
  slots,
  onSlotsChange,
  notice,
  onDismissNotice,
  onContinue,
  title,
  continueLabel = 'Continue',
  continueDisabled = false,
  excludeReservationId,
}: SelectTimeStepProps) {
  const strip = useMemo(
    () => buildDateStrip(todayDateKey(timezone), type.maxAdvanceDays),
    [timezone, type.maxAdvanceDays],
  );
  const [expanded, setExpanded] = useState(() => strip.indexOf(date) >= INITIAL_STRIP_DAYS);
  const visibleStrip = expanded ? strip : strip.slice(0, INITIAL_STRIP_DAYS);

  const availability = useQuery(availabilityQuery(type.code, date, excludeReservationId));
  const day = availability.data?.[0];
  const available = useMemo(() => day?.slots.map((slot) => slot.start) ?? [], [day]);

  // An availability refetch can remove a selected slot (someone else booked
  // it); prune so the selection never holds a time we cannot book.
  useEffect(() => {
    if (!availability.isSuccess) return;
    const availableSet = new Set(available);
    if (slots.every((slot) => availableSet.has(slot))) return;
    onSlotsChange(pruneSelection(slots, available, type.slotDurationMinutes));
  }, [availability.isSuccess, available, slots, onSlotsChange, type.slotDurationMinutes]);

  const canContinue = slots.length > 0 && !continueDisabled;

  return (
    <StepShell
      title={title ?? `Book a ${resourceNoun(type.name)}`}
      footer={
        <PrimaryButton
          label={continueLabel}
          onPress={canContinue ? onContinue : undefined}
          variant={canContinue ? 'primary' : 'ghost'}
        />
      }
    >
      {notice ? (
        <View style={styles.noticeBox} accessibilityRole="alert">
          <Text style={styles.noticeText}>{notice}</Text>
          <Pressable accessibilityRole="button" onPress={onDismissNotice} hitSlop={6}>
            <Text style={styles.noticeDismiss}>Dismiss</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>Select date</Text>
        {!expanded && strip.length > INITIAL_STRIP_DAYS ? (
          <Pressable accessibilityRole="button" onPress={() => setExpanded(true)} hitSlop={6}>
            <Text style={styles.sectionLink}>More dates</Text>
          </Pressable>
        ) : null}
      </View>

      <DateStrip
        dates={visibleStrip}
        value={date}
        onChange={(next) => {
          onDismissNotice();
          onDateChange(next);
        }}
      />

      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>Select slots</Text>
      </View>

      {availability.isPending ? (
        <View style={styles.slotList} accessibilityLabel="Loading available times">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height={52} borderRadius={radius.md} />
          ))}
        </View>
      ) : availability.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load the available times.</Text>
          <PrimaryButton
            label="Try again"
            variant="secondary"
            onPress={() => void availability.refetch()}
          />
        </View>
      ) : available.length === 0 ? (
        <EmptyStateView
          title="No available times"
          description="This day is fully booked. Try another date."
        />
      ) : (
        <View style={styles.slotList} accessibilityRole="list">
          {available.map((slot) => (
            <SlotPill
              key={slot}
              slot={slot}
              slotDurationMinutes={type.slotDurationMinutes}
              selected={slots.includes(slot)}
              onToggle={() => {
                onDismissNotice();
                onSlotsChange(toggleSlot(slots, slot, type.slotDurationMinutes));
              }}
            />
          ))}
        </View>
      )}
    </StepShell>
  );
}

function DateStrip({
  dates,
  value,
  onChange,
}: {
  dates: string[];
  value: string;
  onChange: (date: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.dateStrip}
      accessibilityRole="radiogroup"
      accessibilityLabel="Select date"
    >
      {dates.map((key) => {
        const parts = formatStripDay(key);
        const selected = key === value;
        return (
          <Pressable
            key={key}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={`${parts.weekday} ${parts.day}`}
            onPress={() => onChange(key)}
            style={({ pressed }) => [
              styles.dateTile,
              selected ? styles.dateTileSelected : null,
              pressed ? styles.dateTilePressed : null,
            ]}
          >
            <Text style={[styles.dateWeekday, selected ? styles.dateTextSelected : null]}>
              {parts.weekday}
            </Text>
            <Text style={[styles.dateDay, selected ? styles.dateTextSelected : null]}>
              {parts.day}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionLabel: {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sectionLink: {
    color: colors.accent,
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
  },
  dateStrip: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    paddingRight: spacing.md,
  },
  dateTile: {
    width: 58,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dateTileSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  dateTilePressed: {
    opacity: 0.9,
  },
  dateWeekday: {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  dateDay: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 18,
  },
  dateTextSelected: {
    color: colors.textOnAccent,
  },
  slotList: {
    gap: spacing.sm,
  },
  noticeBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.dangerStrong,
    backgroundColor: colors.surfaceOverlay,
  },
  noticeText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 19,
  },
  noticeDismiss: {
    color: colors.accent,
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
  },
  errorBox: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  errorText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
});
