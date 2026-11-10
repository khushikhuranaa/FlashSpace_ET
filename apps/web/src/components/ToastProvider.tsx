import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  leaving: boolean;
}

interface ToastContextValue {
  toast: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE: Record<ToastTone, { icon: IconName; className: string }> = {
  success: { icon: 'check-circle', className: 'text-emerald-600' },
  error: { icon: 'alert-circle', className: 'text-red-600' },
  info: { icon: 'inbox', className: 'text-flash-600' },
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = nextId++;
    setItems((prev) => [...prev, { id, message, tone, leaving: false }]);
    window.setTimeout(() => {
      setItems((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    }, 3000);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 3300);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {items.map((item) => {
          const tone = TONE[item.tone];
          return (
            <div
              key={item.id}
              className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line bg-white px-4 py-3 text-[13px] font-medium text-primary shadow-lg ${
                item.leaving ? 'animate-toast-out' : 'animate-toast-in'
              }`}
            >
              <Icon name={tone.icon} className={`mt-0.5 h-4 w-4 shrink-0 ${tone.className}`} />
              <span className="min-w-0 flex-1">{item.message}</span>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-slate-400 transition hover:text-primary"
                onClick={() => setItems((prev) => prev.filter((t) => t.id !== item.id))}
                aria-label="Dismiss notification"
              >
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

/** Convenience hook for pages that only need to push messages. */
export function useToastMessage(): (message: string, tone?: ToastTone) => void {
  const { toast } = useToast();
  return toast;
}
