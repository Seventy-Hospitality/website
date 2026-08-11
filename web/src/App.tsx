import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MembersPage } from './pages/MembersPage';
import { SignInPage } from './pages/SignInPage';
import { BookingsPage } from './pages/BookingsPage';
import { FacilitiesPage } from './pages/FacilitiesPage';
import { EventsPage } from './pages/EventsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuthGuard } from './components/AuthGuard';

function Protected({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}

export default function App() {
  return (
    <BrowserRouter basename="/admin">
      <Routes>
        <Route path="/" element={<Protected><Navigate to="/members" replace /></Protected>} />
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/members" element={<Protected><MembersPage /></Protected>} />
        <Route path="/bookings" element={<Protected><Navigate to="/bookings/courts" replace /></Protected>} />
        <Route path="/bookings/:tab" element={<Protected><BookingsPage /></Protected>} />
        <Route path="/facilities" element={<Protected><FacilitiesPage /></Protected>} />
        <Route path="/events" element={<Protected><EventsPage /></Protected>} />
        <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      </Routes>
    </BrowserRouter>
  );
}
