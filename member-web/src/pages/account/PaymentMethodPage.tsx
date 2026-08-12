import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { ChevronLeft } from 'lucide-react';
import { api } from '../../lib/api';
import { getStripe } from '../../lib/stripe';
import { StripeProvider } from '../../lib/StripeProvider';
import { PageHeader } from '../../app/AppShell';
import { Button, EmptyState, Skeleton, useToast } from '../../components';
import styles from './account.module.css';

/**
 * Edit payment method (the billing card's Edit action): W1's Stripe
 * wiring in setup mode. POST /api/me/payment-methods/setup-intent mints a
 * SetupIntent client secret, the Payment Element mounts on it (card data
 * never touches our code), stripe.confirmSetup() collects the card, and
 * POST /api/me/payment-methods/:id/default makes it the default on both
 * the Stripe customer and the live subscription. Redirect-based methods
 * return to this page and are finished from the redirect params.
 */
export function PaymentMethodPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const redirectSecret = searchParams.get('setup_intent_client_secret');
  const stripeReady = getStripe() !== null;

  const [notice, setNotice] = useState<string | null>(null);
  const [processingHold, setProcessingHold] = useState(false);

  const setup = useMutation({ mutationFn: api.createPaymentMethodSetupIntent });

  const setDefault = useMutation({
    mutationFn: api.setDefaultPaymentMethod,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['membership'] });
      toast({ message: 'Payment method updated', variant: 'success' });
      navigate('/account/billing', { replace: true });
    },
  });

  // Mint the SetupIntent once on entry (not when returning from a redirect).
  const started = useRef(false);
  const setupMutate = setup.mutate;
  useEffect(() => {
    if (!stripeReady || redirectSecret !== null || started.current) return;
    started.current = true;
    setupMutate();
  }, [stripeReady, redirectSecret, setupMutate]);

  // Returned from a redirect-based method: read the SetupIntent back and
  // finish with the set-default call.
  const redirectHandled = useRef(false);
  const setDefaultMutate = setDefault.mutate;
  useEffect(() => {
    if (redirectSecret === null || redirectHandled.current) return;
    redirectHandled.current = true;
    void (async () => {
      const stripe = await getStripe();
      setSearchParams(new URLSearchParams(), { replace: true });
      if (!stripe) return;
      const { setupIntent } = await stripe.retrieveSetupIntent(redirectSecret);
      if (setupIntent?.status === 'succeeded' && typeof setupIntent.payment_method === 'string') {
        setDefaultMutate(setupIntent.payment_method);
        return;
      }
      if (setupIntent?.status === 'processing') {
        setProcessingHold(true);
        return;
      }
      // Failed or unknown: back to a fresh form with a notice.
      setNotice('Your card could not be saved. Please try again.');
      started.current = true;
      setupMutate();
    })();
  }, [redirectSecret, setSearchParams, setDefaultMutate, setupMutate]);

  return (
    <div className={styles.page}>
      <Link to="/account/billing" className={styles.backLink}>
        <ChevronLeft aria-hidden />
        Back to billing
      </Link>
      <PageHeader title="Payment method" />

      {!stripeReady && (
        <EmptyState
          title="Payments are not configured"
          description="Set VITE_STRIPE_PUBLISHABLE_KEY to manage payment methods in this environment."
        />
      )}

      {stripeReady && processingHold && (
        <div className={styles.processing} role="status">
          <p className={styles.processingTitle}>Your payment method is being confirmed</p>
          <p className={styles.processingBody}>
            This can take a moment for some payment methods. Your card will become the default
            automatically once it clears.
          </p>
          <Button variant="secondary" size="sm" onClick={() => navigate('/account/billing')}>
            Back to billing
          </Button>
        </div>
      )}

      {stripeReady && !processingHold && (
        <>
          {notice && (
            <p role="alert" className={styles.payAlert}>
              {notice}
            </p>
          )}

          {(setup.isPending || (redirectSecret !== null && !setDefault.isError)) && (
            <div className={styles.loadingStack} aria-busy="true" role="status">
              <span className="visually-hidden">Preparing the secure card form</span>
              <Skeleton height="12rem" shape="card" />
              <Skeleton height="2.75rem" shape="card" />
            </div>
          )}

          {setup.isError && (
            <div className={styles.errorBox} role="alert">
              <p>We could not start the card update.</p>
              <Button variant="secondary" size="sm" onClick={() => setup.mutate()}>
                Try again
              </Button>
            </div>
          )}

          {setDefault.isError && (
            <div className={styles.errorBox} role="alert">
              <p>
                Your card was saved, but we could not make it your default. Retry; you will not
                be charged.
              </p>
              <Button
                variant="secondary"
                size="sm"
                loading={setDefault.isPending}
                onClick={() => {
                  if (setDefault.variables) setDefault.mutate(setDefault.variables);
                }}
              >
                Try again
              </Button>
            </div>
          )}

          {setup.isSuccess && !setDefault.isError && (
            <StripeProvider key={setup.data.clientSecret} clientSecret={setup.data.clientSecret}>
              <SetupForm
                savePending={setDefault.isPending}
                onSaved={(paymentMethodId) => setDefault.mutate(paymentMethodId)}
                onProcessing={() => setProcessingHold(true)}
              />
            </StripeProvider>
          )}
        </>
      )}
    </div>
  );
}

function SetupForm({
  savePending,
  onSaved,
  onProcessing,
}: {
  savePending: boolean;
  onSaved: (paymentMethodId: string) => void;
  onProcessing: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: `${window.location.origin}/account/payment-method` },
        // Cards complete inline; only redirect-based methods leave the page.
        redirect: 'if_required',
      });
      if (result.error) {
        setError(
          result.error.type === 'card_error' || result.error.type === 'validation_error'
            ? (result.error.message ?? 'Your card could not be saved.')
            : 'Something went wrong saving your card. Please try again.',
        );
        return;
      }
      const intent = result.setupIntent;
      if (intent.status === 'succeeded' && typeof intent.payment_method === 'string') {
        onSaved(intent.payment_method);
      } else if (intent.status === 'processing') {
        onProcessing();
      } else {
        setError('Your card could not be saved. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.paymentForm} onSubmit={submit} noValidate>
      {!ready && (
        <div aria-busy="true" role="status">
          <span className="visually-hidden">Loading the secure card form</span>
          <Skeleton height="10rem" shape="card" />
        </div>
      )}
      <div className={ready ? undefined : styles.paymentHidden}>
        <PaymentElement onReady={() => setReady(true)} />
      </div>

      {error && (
        <p role="alert" className={styles.payAlert}>
          {error}
        </p>
      )}

      <Button type="submit" fullWidth disabled={!ready || !stripe} loading={submitting || savePending}>
        Save payment method
      </Button>
    </form>
  );
}
