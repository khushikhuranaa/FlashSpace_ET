/** @type {import('tailwindcss').Config} */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Anchor content globs to this file, not process.cwd(), so the class scan
// works no matter which directory Vite was launched from.
const appDir = dirname(fileURLToPath(import.meta.url));

export default {
  content: [join(appDir, 'index.html'), join(appDir, 'src/**/*.{ts,tsx}')],
  theme: {
    extend: {
      colors: {
        // Reference palette: indigo brand + slate neutrals. Existing `flash-*`
        // classes keep working, they simply resolve to the new brand scale.
        flash: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
        surface: '#f8fafc',
        card: '#ffffff',
        primary: '#0f172a',
        muted: '#64748b',
        line: '#e2e8f0',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        xs: '0 1px 2px 0 rgb(15 23 42 / 0.04)',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        toastIn: {
          from: { opacity: '0', transform: 'translateY(12px) scale(0.95)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        toastOut: {
          from: { opacity: '1', transform: 'translateY(0) scale(1)' },
          to: { opacity: '0', transform: 'translateY(12px) scale(0.95)' },
        },
        countdownPulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'toast-in': 'toastIn 0.3s ease-out',
        'toast-out': 'toastOut 0.3s ease-out forwards',
        'countdown-pulse': 'countdownPulse 1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
