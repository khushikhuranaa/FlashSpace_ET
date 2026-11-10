import { fileURLToPath } from 'node:url';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

/**
 * `tailwindcss: {}` resolves `tailwind.config.js` from `process.cwd()`, so
 * launching Vite from the monorepo root (IDE tasks, `npx vite`, CI) made the
 * custom theme tokens (flash-*, surface, line, …) disappear and every
 * `@apply border-line`-style rule failed with "class does not exist".
 * Pinning the config path makes compilation cwd-independent.
 */
const tailwindConfig = fileURLToPath(new URL('./tailwind.config.js', import.meta.url));

export default {
  plugins: [tailwindcss({ config: tailwindConfig }), autoprefixer()],
};
