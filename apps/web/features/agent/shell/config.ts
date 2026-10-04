// Build-time configuration. The only place that reads import.meta.env (node tests never import this file).
import { resolveApiBase } from './api.ts';

/** '' in dev (the Vite proxy forwards /api), https://apprentice.exe.xyz in production builds, VITE_API_BASE overrides. */
export const API_BASE: string = resolveApiBase(import.meta.env.VITE_API_BASE, import.meta.env.PROD);
