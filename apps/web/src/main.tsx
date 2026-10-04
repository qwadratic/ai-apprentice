import { createRoot } from 'react-dom/client';
import { Foundation } from '../foundation/Foundation.tsx';
// Stream B replaces this one import/render pair with its product app shell.
createRoot(document.getElementById('root')!).render(<Foundation />);
