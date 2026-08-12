import { fireEvent, render, screen } from '@testing-library/react-native';
import { Badge } from '../Badge';
import { Chip } from '../Chip';
import { SegmentedControl } from '../SegmentedControl';
import { Avatar } from '../Avatar';
import { Checkbox } from '../Checkbox';
import { PrimaryButton } from '../PrimaryButton';

describe('Badge', () => {
  it('renders its label', () => {
    render(<Badge label="Confirmed" variant="success" />);
    expect(screen.getByText('Confirmed')).toBeTruthy();
  });
});

describe('Avatar', () => {
  it('falls back to initials when there is no image', () => {
    render(<Avatar name="Alex Morgan" />);
    expect(screen.getByText('AM')).toBeTruthy();
  });
});

describe('Chip', () => {
  it('renders the label and a labelled remove control', () => {
    const onRemove = jest.fn();
    render(<Chip label="Sam Lee" onRemove={onRemove} />);
    expect(screen.getByText('Sam Lee')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Remove Sam Lee'));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe('SegmentedControl', () => {
  it('renders options and reports the selected value on press', () => {
    const onChange = jest.fn();
    render(
      <SegmentedControl
        label="Sign-in method"
        value="password"
        onChange={onChange}
        options={[
          { value: 'password', label: 'Password' },
          { value: 'magic', label: 'Magic link' },
        ]}
      />,
    );

    expect(screen.getByText('Password')).toBeTruthy();
    fireEvent.press(screen.getByText('Magic link'));
    expect(onChange).toHaveBeenCalledWith('magic');
  });
});

describe('Checkbox (hoisted from M1 checkout terms gate)', () => {
  it('reports a toggle and reflects the checked/disabled a11y state', () => {
    const onChange = jest.fn();
    render(
      <Checkbox checked={false} onChange={onChange} accessibilityLabel="Agree to terms" label="Agree to terms" />,
    );
    const box = screen.getByLabelText('Agree to terms');
    expect(box.props.accessibilityState).toMatchObject({ checked: false, disabled: false });
    fireEvent.press(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle when disabled', () => {
    const onChange = jest.fn();
    render(
      <Checkbox
        checked
        disabled
        onChange={onChange}
        accessibilityLabel="Agree to terms"
        label="Agree to terms"
      />,
    );
    const box = screen.getByLabelText('Agree to terms');
    expect(box.props.accessibilityState).toMatchObject({ checked: true, disabled: true });
    fireEvent.press(box);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('PrimaryButton disabled prop (replaces the M1 GatedButton wrapper)', () => {
  it('fires onPress and announces an enabled button by default', () => {
    const onPress = jest.fn();
    render(<PrimaryButton label="Confirm membership" onPress={onPress} />);
    const button = screen.getByLabelText('Confirm membership');
    expect(button.props.accessibilityState).toMatchObject({ disabled: false });
    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is muted and non-interactive when disabled', () => {
    const onPress = jest.fn();
    render(<PrimaryButton label="Confirm membership" disabled onPress={onPress} />);
    const button = screen.getByLabelText('Confirm membership');
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('blocks presses while loading', () => {
    const onPress = jest.fn();
    render(<PrimaryButton label="Confirm membership" loading onPress={onPress} />);
    const button = screen.getByLabelText('Confirm membership');
    expect(button.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});
