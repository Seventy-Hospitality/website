import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/manrope';
import '@fontsource-variable/inter';
import './theme/tokens.css';
import './index.css';
import { queryClient } from './lib/query-client';
import { SessionProvider } from './lib/session';
import { ToastProvider } from './components';
import App from './App';

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
