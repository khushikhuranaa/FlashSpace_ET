/** @type {import('tailwindcss').Config} */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Anchor content globs to this file, not process.cwd(), so the class scan
// works no matter which directory Vite was launched from.
const appDir = dirname(fileURLToPath(import.meta.url));

/**
 * FlashSpace design tokens (Module 13).
 *
 * Canonical approved appearance: mixed light + dark composition with teal/mint
 * accents. Dark sidebar/navigation, light workspace, light cards and forms.
 *
 * `flash-*` is the single approved brand scale (teal/mint). Semantic tints and
 * status scales are kept recognizable (success/warning/danger/info) rather than
 * forced into teal.
 */
export default {
  content: [join(appDir, 'index.html'), join(appDir, 'src/**/*.{ts,tsx}')],
  darkMode: 'class',
  theme: {
    extend: {
      borderColor: {
        // Keep `border-border` and `border-border-strong` as first-class
        // utilities so component primitives and inline markup can use them.
        border: 'var(--color-border)',
        'border-strong': 'var(--color-border-strong)',
      },
      colors: {
        // Approved mixed light + dark surface and navigation tokens.
        surface: {
          // Main workspace background.
          DEFAULT: '#F2F7F6',
          // Dark navigation surfaces.
          dark: '#172D32',
          secondary: '#203A3F',
          'sidebar-hover': '#203A3F',
        },
        card: {
          DEFAULT: '#FFFFFF',
          muted: '#EAF7F4',
        },
        border: {
          DEFAULT: '#DCE7E4',
          strong: '#C7D9D4',
        },
        // Dark sidebar text layer.
        sidebar: {
          text: '#FFFFFF',
          secondary: '#A8C4C0',
        },
        // Approved teal/mint brand scale — replaces the old indigo/blue brand
        // scale app-wide. Only the neutral surface and semantic scales are kept
        // recognizable.
        flash: {
          50: '#DDF4EF',
          100: '#D0EEF0',
          200: '#A9DBD3',
          300: '#77C7BE',
          400: '#45B3A5',
          500: '#0D9488',
          600: '#0F766E',
          700: '#17645F',
          800: '#183336',
          900: '#172D32',
        },
        // Semantic state scales — recognizable, not forced to teal.
        success: { 50: '#F0FDF4', 100: '#DCFCE7', 200: '#BBF7D0', 600: '#15803D', 700: '#166534' },
        warning: { 50: '#FEFCE8', 100: '#FEF3C7', 200: '#FDE68A', 600: '#B45309', 700: '#92400E' },
        danger: { 50: '#FEF2F2', 100: '#FEE2E2', 200: '#FECACA', 600: '#DC2626', 700: '#B91C1C' },
        info: { 50: '#F0F9FF', 100: '#E0F2FE', 200: '#BADBFE', 600: '#0284C7', 700: '#0369A1' },
        // Neutrals / text layer on light surfaces.
        primary: '#183336',
        secondary: '#637A78',
        muted: '#879996',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Type scale: page titles -> section titles -> body -> helper text.
      fontSize: {
        'page': ['22px', { lineHeight: '1.25', letterSpacing: '-0.015em', fontWeight: '700' }],
        'section': ['15px', { lineHeight: '1.4', letterSpacing: '-0.01em', fontWeight: '700' }],
        'body': ['13.5px', { lineHeight: '1.55' }],
        'support': ['12px', { lineHeight: '1.5' }],
        'label': ['12px', { lineHeight: '1.4', fontWeight: '500' }],
        'table': ['13px', { lineHeight: '1.45' }],
      },
      borderRadius: {
        control: '8px',
        card: '12px',
        modal: '16px',
      },
      spacing: {
        // Named vertical rhythm used by page shells and cards.
        'page': '24px',
        'section': '20px',
        'card': '20px',
      },
      boxShadow: {
        xs: '0 1px 2px 0 rgb(24 51 54 / 0.04)',
        card: '0 1px 3px 0 rgb(24 51 54 / 0.06), 0 1px 2px -1px rgb(24 51 54 / 0.04)',
        pop: '0 10px 30px -12px rgb(24 51 54 / 0.25)',
      },
      maxWidth: {
        shell: '76rem',
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

