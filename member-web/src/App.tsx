import { BrowserRouter, Route, Routes } from 'react-router-dom';
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
import { AccountPage } from './pages/account/AccountPage';
import { OnboardingPage } from './pages/onboarding/OnboardingPage';
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

        {/* Protected member app. */}
        <Route element={<MemberAuthGuard />}>
          {/* Full-screen onboarding flow, outside the tab shell (W1). */}
          <Route path="/onboarding/*" element={<OnboardingPage />} />

          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route
              path="/reserve/*"
              element={
                <PlaceholderPage
                  title="Reserve"
                  ownerPackage="W3"
                  description="Pick an activity, choose your slots, invite players, and pay"
                />
              }
            />
            <Route
              path="/reservations/:reservationId"
              element={
                <PlaceholderPage
                  title="Reservation"
                  ownerPackage="W4"
                  description="Reservation details, invitations, rescheduling, and cancellation"
                />
              }
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

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
