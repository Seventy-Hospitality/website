import { useState, type FormEvent } from 'react';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { StripeProvider } from '../../lib/StripeProvider';
import { Button, Skeleton } from '../../components';
import styles from './account.module.css';

/**
 * The upgrade-proration payment step (W1's Payment Element wiring): mounts
 * on the proration invoice's confirmation secret, confirms inline
 * (redirect only for redirect-based methods), then hands back to the
 * caller's confirm read-back. No card data ever touches our code.
 */
export function ProrationPaymentForm({
  clientSecret,
  returnUrl,
  payNotice,
  confirmPending,
  onPaid,
}: {
  clientSecret: string;
  returnUrl: string;
  payNotice: string | null;
  confirmPending: boolean;
  onPaid: () => void;
}) {
  return (
    <StripeProvider key={clientSecret} clientSecret={clientSecret}>
      <ProrationPaymentFields
        returnUrl={returnUrl}
        payNotice={payNotice}
        confirmPending={confirmPending}
        onPaid={onPaid}
      />
    </StripeProvider>
  );
}

function ProrationPaymentFields({
  returnUrl,
  payNotice,
  confirmPending,
  onPaid,
}: {
  returnUrl: string;
  payNotice: string | null;
  confirmPending: boolean;
  onPaid: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements || paying) return;
    setPaying(true);
    setPayError(null);
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: 'if_required',
      });
      if (error) {
        setPayError(
          error.type === 'card_error' || error.type === 'validation_error'
            ? (error.message ?? 'Your payment could not be completed.')
            : 'Payment failed. Please check your details and try again.',
        );
        return;
      }
      onPaid();
    } finally {
      setPaying(false);
    }
  }

  const alert = payError ?? payNotice;

  return (
    <form className={styles.paymentForm} onSubmit={pay} noValidate>
      {!ready && (
        <div aria-busy="true" role="status">
          <span className="visually-hidden">Loading secure payment form</span>
          <Skeleton height="10rem" shape="card" />
        </div>
      )}
      <div className={ready ? undefined : styles.paymentHidden}>
        <PaymentElement onReady={() => setReady(true)} />
      </div>

      {alert && (
        <p role="alert" className={styles.payAlert}>
          {alert}
        </p>
      )}

      <Button type="submit" fullWidth disabled={!ready || !stripe} loading={paying || confirmPending}>
        Pay and switch plan
      </Button>
    </form>
  );
}
