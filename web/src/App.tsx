import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MembersPage } from './pages/MembersPage';

import { SignInPage } from './pages/SignInPage';
import { BookingsPage } from './pages/BookingsPage';
import { FacilitiesPage } from './pages/FacilitiesPage';


export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/members" replace />} />
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/members" element={<MembersPage />} />

        <Route path="/bookings" element={<Navigate to="/bookings/courts" replace />} />
        <Route path="/bookings/:tab" element={<BookingsPage />} />
        <Route path="/facilities" element={<FacilitiesPage />} />
      </Routes>
    </BrowserRouter>
  );
}
