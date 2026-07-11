import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: '#121316',
          color: '#f8f9fa',
          fontFamily: 'system-ui, sans-serif',
          padding: '24px',
          textAlign: 'center'
        }}>
          <h2 style={{ fontSize: '24px', marginBottom: '16px', color: '#ff3366' }}>Что-то пошло не так</h2>
          <p style={{ fontSize: '14px', color: '#adb5bd', marginBottom: '24px', maxWidth: '400px', wordBreak: 'break-all' }}>
            {this.state.error?.toString()}
          </p>
          <button
            onClick={() => {
              localStorage.clear();
              window.location.reload();
            }}
            style={{
              padding: '12px 24px',
              backgroundColor: '#aa3bff',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontWeight: 'bold',
              cursor: 'pointer'
            }}
          >
            Сбросить настройки и перезагрузить
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// Handle service worker registration/unregistration for Capacitor vs PWA
const isCapacitor = !!(window as any).Capacitor || !!(window as any).ComiFlowBridge;

if ('serviceWorker' in navigator) {
  if (isCapacitor) {
    // Unregister any legacy service workers on Capacitor to prevent caching index.html (which causes white screen on updates)
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      let shouldReload = false;
      for (const registration of registrations) {
        registration.unregister();
        shouldReload = true;
      }
      if (shouldReload) {
        console.log('SW unregistered. Reloading to clear caches.');
        window.location.reload();
      }
    });
  } else if (import.meta.env.PROD) {
    // Register PWA service worker only for web environments
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => console.log('ServiceWorker registered:', reg.scope))
        .catch((err) => console.warn('ServiceWorker registration failed:', err));
    });
  }
}

