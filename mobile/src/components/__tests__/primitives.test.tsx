import { fireEvent, render, screen } from '@testing-library/react-native';
import { Badge } from '../Badge';
import { Chip } from '../Chip';
import { SegmentedControl } from '../SegmentedControl';
import { Avatar } from '../Avatar';

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
