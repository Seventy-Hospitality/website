import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AnonymousOnly, MemberAuthGuard } from './lib/session';
import { AppShell } from './app/AppShell';
import { StartPage } from './pages/auth/StartPage';
import { SignInPage } from './pages/auth/SignInPage';
import { SignUpPage } from './pages/auth/SignUpPage';
import { MagicLinkPage } from './pages/auth/MagicLinkPage';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage';
import { VerifyEmailPage } from './pages/auth/VerifyEmailPage';
import { AuthCallbackPage } from './pages/auth/AuthCallbackPage';
import { HomePage } from './pages/home/HomePage';
import { ReservePage } from './pages/reserve/ReservePage';
import { BookingWizardPage } from './pages/reserve/BookingWizardPage';
import { ReservationDetailPage } from './pages/reservations/ReservationDetailPage';
import { EditReservationPage } from './pages/reservations/EditReservationPage';
import { InviteParticipantsPage } from './pages/reservations/InviteParticipantsPage';
import { AccountPage } from './pages/account/AccountPage';
import { OnboardingGate } from './pages/onboarding/OnboardingGate';
import { ChoosePlanPage } from './pages/onboarding/ChoosePlanPage';
import { CheckoutPage } from './pages/onboarding/CheckoutPage';
import { VerifyIdentityPage } from './pages/onboarding/VerifyIdentityPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { NotFoundPage } from './pages/NotFoundPage';

/**
 * Route map. Flow packages own their subtrees and replace the placeholders:
 *   W1 /onboarding/*        W2 /            W3 /reserve/*
 *   W4 /reservations/:id    W5 /clubs/*     W6 /account/*
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public auth area; signed-in members are bounced into the app. */}
        <Route element={<AnonymousOnly />}>
          <Route path="/start" element={<StartPage />} />
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/sign-up" element={<SignUpPage />} />
          <Route path="/magic-link" element={<MagicLinkPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        </Route>

        {/* Token landings work whether or not a session exists. */}
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />

        {/* Protected member app. The OnboardingGate (W1) resolves the
            member's onboarding step and enforces it in both directions:
            unfinished members are pushed into /onboarding/*, finished
            members are kept out of it. */}
        <Route element={<MemberAuthGuard />}>
          <Route element={<OnboardingGate />}>
            {/* Full-screen onboarding flow, outside the tab shell (W1). */}
            <Route path="/onboarding" element={<Navigate to="/onboarding/plan" replace />} />
            <Route path="/onboarding/plan" element={<ChoosePlanPage />} />
            <Route path="/onboarding/checkout" element={<CheckoutPage />} />
            <Route path="/onboarding/verify-identity" element={<VerifyIdentityPage />} />

            {/* Booking wizard (W3): full-screen, outside the tab shell,
                per the Figma frames (back arrow + close + progress). */}
            <Route path="/reserve/:typeCode" element={<BookingWizardPage />} />

            {/* Reservation edit + invite (W4): full-screen wizard chrome,
                outside the tab shell, mirroring the booking wizard. */}
            <Route
              path="/reservations/:reservationId/edit"
              element={<EditReservationPage />}
            />
            <Route
              path="/reservations/:reservationId/invite"
              element={<InviteParticipantsPage />}
            />

            <Route element={<AppShell />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/reserve" element={<ReservePage />} />
              <Route
                path="/reservations/:reservationId"
                element={<ReservationDetailPage />}
              />
              <Route
                path="/clubs"
                element={
                  <PlaceholderPage
                    title="Clubs"
                    ownerPackage="W5"
                    description="Your clubs and the clubs you can join"
                  />
                }
              />
              <Route
                path="/clubs/new"
                element={
                  <PlaceholderPage
                    title="Create a club"
                    ownerPackage="W5"
                    description="The club creation wizard"
                  />
                }
              />
              <Route
                path="/clubs/:clubId/*"
                element={
                  <PlaceholderPage
                    title="Club"
                    ownerPackage="W5"
                    description="Club details, roster, invites, and activity"
                  />
                }
              />
              <Route path="/account/*" element={<AccountPage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
