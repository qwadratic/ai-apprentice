import { createRoot } from 'react-dom/client';
import { AppShell } from '../features/agent/shell/index.ts';
// Stream B replaces this one import/render pair with its product app shell.
createRoot(document.getElementById('root')!).render(<AppShell />);
