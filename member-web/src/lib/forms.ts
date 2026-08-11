/**
 * Form conventions: react-hook-form + zod (the mobile app's pattern, ported).
 * Screens define a zod schema, call useZodForm(schema), and render fields
 * through <FormField> so labels/errors stay accessible. Server-side
 * ApiErrors surface through toasts or a form-level error, never alerts.
 */
import { useForm, type FieldValues, type UseFormProps, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

export function useZodForm<Input extends FieldValues, Output extends FieldValues>(
  schema: z.ZodType<Output, Input>,
  options?: Omit<UseFormProps<Input, unknown, Output>, 'resolver'>,
): UseFormReturn<Input, unknown, Output> {
  return useForm<Input, unknown, Output>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    ...options,
  });
}

// ── Shared field schemas (match the backend's validation) ──

export const emailField = z
  .string()
  .trim()
  .min(1, 'Enter your email')
  .email('Enter a valid email');

export const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(256, 'Password is too long');

export const nameField = z
  .string()
  .trim()
  .min(1, 'Enter your full name')
  .max(200, 'Name is too long');

export const phoneField = z
  .string()
  .trim()
  .max(30, 'Phone number is too long')
  .regex(/^[+\d][\d\s().-]*$/, 'Enter a valid phone number')
  .optional()
  .or(z.literal(''));

// ── Auth form schemas ──

export const signUpSchema = z.object({
  name: nameField,
  email: emailField,
  password: passwordField,
  phone: phoneField,
});
export type SignUpForm = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Enter your password'),
});
export type SignInForm = z.infer<typeof signInSchema>;

export const emailOnlySchema = z.object({
  email: emailField,
});
export type EmailOnlyForm = z.infer<typeof emailOnlySchema>;

export const resetPasswordSchema = z
  .object({
    password: passwordField,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });
export type ResetPasswordForm = z.infer<typeof resetPasswordSchema>;
