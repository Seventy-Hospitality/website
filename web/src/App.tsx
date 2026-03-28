import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MembersPage } from './pages/MembersPage';
import { MemberDetailPage } from './pages/MemberDetailPage';
import { NewMemberPage } from './pages/NewMemberPage';
import { SignInPage } from './pages/SignInPage';
import { BookingsPage } from './pages/BookingsPage';
import { MyBookingsPage } from './pages/MyBookingsPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/members" replace />} />
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/members/new" element={<NewMemberPage />} />
        <Route path="/members/:id" element={<MemberDetailPage />} />
        <Route path="/bookings" element={<BookingsPage />} />
        <Route path="/bookings/mine" element={<MyBookingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
