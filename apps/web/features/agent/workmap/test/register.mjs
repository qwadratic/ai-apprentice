// Test-only: lets node --test import the board's .tsx files (via esbuild, which Vite already installs) and stubs CSS imports.
// Usage: node --import ./features/agent/workmap/test/register.mjs --test "features/agent/workmap/test/*.test.ts"
import { register } from 'node:module';

register('./tsx-hooks.mjs', import.meta.url);
