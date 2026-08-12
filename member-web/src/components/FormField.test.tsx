import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormField, Input } from './FormField';

describe('FormField', () => {
  it('associates the label with the control', () => {
    render(
      <FormField label="Email">{(field) => <Input type="email" {...field} />}</FormField>,
    );

    expect(screen.getByLabelText('Email')).toBeInstanceOf(HTMLInputElement);
  });

  it('wires the error message via aria-describedby and marks the field invalid', () => {
    render(
      <FormField label="Email" error="Enter a valid email">
        {(field) => <Input type="email" {...field} />}
      </FormField>,
    );

    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('Enter a valid email');
  });

  it('shows the hint when there is no error', () => {
    render(
      <FormField label="Password" hint="At least 8 characters">
        {(field) => <Input type="password" {...field} />}
      </FormField>,
    );

    const input = screen.getByLabelText('Password');
    const describedBy = input.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)).toHaveTextContent('At least 8 characters');
    expect(input).not.toHaveAttribute('aria-invalid');
  });
});
