import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { applyTheme, followThemeAcrossTabs } from './lib/theme';

import './index.css';

// Apply the saved/system theme before first paint to avoid a light flash in dark mode.
applyTheme();
followThemeAcrossTabs();

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
