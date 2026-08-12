import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/manrope';
import '@fontsource-variable/inter';
import './theme/tokens.css';
import './index.css';
import { queryClient } from './lib/query-client';
import { venueQuery } from './lib/venue';
import { SessionProvider } from './lib/session';
import { ToastProvider } from './components';
import App from './App';

// Warm the venue timezone before any date math needs it (cached for the
// life of the tab; useVenueTimezone falls back to the browser zone until
// it lands, so nothing awaits this).
void queryClient.prefetchQuery(venueQuery);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
