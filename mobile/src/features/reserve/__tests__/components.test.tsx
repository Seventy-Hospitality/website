import { fireEvent, render, screen } from '@testing-library/react-native';
import { ReservationSummaryCard } from '../ReservationSummaryCard';
import { SlotPill } from '../SlotPill';
import { resourceTypeGlyph } from '../ResourceTypeIcon';

describe('ReservationSummaryCard (reusable for M2/M4)', () => {
  it('renders the amenity, court and label/value rows', () => {
    render(
      <ReservationSummaryCard
        typeCode="badminton_court"
        typeName="Badminton Court"
        resourceName="Court 2"
        rows={[
          { label: 'Date', value: 'Monday, Aug 17' },
          { label: 'Amount paid', value: '$20.00' },
        ]}
      />,
    );
    expect(screen.getByText('Badminton Court')).toBeTruthy();
    expect(screen.getByText('Court 2')).toBeTruthy();
    expect(screen.getByText('Date')).toBeTruthy();
    expect(screen.getByText('$20.00')).toBeTruthy();
  });
});

describe('SlotPill (reusable slot cell)', () => {
  it('renders the 30-min range label and reports a toggle', () => {
    const onToggle = jest.fn();
    render(<SlotPill slot="20:00" slotDurationMinutes={30} selected={false} onToggle={onToggle} />);
    const pill = screen.getByLabelText('8:00PM - 8:30PM');
    expect(pill).toBeTruthy();
    fireEvent.press(pill);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('resourceTypeGlyph', () => {
  it('maps known amenity codes and falls back for the unknown', () => {
    expect(resourceTypeGlyph('badminton_court')).toBe('tennisball-outline');
    expect(resourceTypeGlyph('shower')).toBe('water-outline');
    expect(resourceTypeGlyph('mystery_room')).toBe('calendar-outline');
  });
});
