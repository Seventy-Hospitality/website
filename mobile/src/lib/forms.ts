/**
 * Form conventions: react-hook-form + zod (mirrors member-web/src/lib/forms.ts).
 * Screens define a schema, call useZodForm(schema), and render fields through
 * <FormField> + <Input>/<PasswordInput>. Server-side ApiErrors surface via a
 * toast or a form-level error, never inline for a specific field unless the
 * code maps to one.
 */
import { useForm, type Resolver, type UseFormProps, type UseFormReturn } from 'react-hook-form';
import type { FieldValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

/**
 * useForm wired to a zod schema whose input and output share a shape (the
 * auth forms), so screens get fully typed `control`/`handleSubmit`.
 */
export function useZodForm<Values extends FieldValues>(
  schema: z.ZodType<Values, Values>,
  options?: Omit<UseFormProps<Values, unknown, Values>, 'resolver'>,
): UseFormReturn<Values, unknown, Values> {
  return useForm<Values, unknown, Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Values, unknown, Values>,
    mode: 'onTouched',
    ...options,
  });
}

// ── Shared field schemas (match the backend validation) ──

export const emailField = z.string().trim().min(1, 'Enter your email').email('Enter a valid email');

export const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(256, 'Password is too long');

export const nameField = z.string().trim().min(1, 'Enter your full name').max(200, 'Name is too long');

export const phoneField = z
  .string()
  .trim()
  .max(30, 'Phone number is too long')
  .regex(/^[+\d][\d\s().-]*$/, 'Enter a valid phone number')
  .optional()
  .or(z.literal(''));

// ── Auth form schemas ──

export const signInSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Enter your password'),
});
export type SignInForm = z.infer<typeof signInSchema>;

export const signUpSchema = z.object({
  name: nameField,
  email: emailField,
  password: passwordField,
  phone: phoneField,
});
export type SignUpForm = z.infer<typeof signUpSchema>;

export const emailOnlySchema = z.object({ email: emailField });
export type EmailOnlyForm = z.infer<typeof emailOnlySchema>;
