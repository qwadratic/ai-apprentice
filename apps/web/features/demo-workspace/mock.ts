import type { CheckpointPort, CheckOutcome } from './workspace.ts';

export type MockResult = CheckOutcome['status'] | 'error' | 'timeout';
/** Explicit offline mock. It never reads the order, draft, customer or a rule. */
export function createMockCheckpoint(result: MockResult = 'clear', delayMs = 350): CheckpointPort {
  return {
    check(_scope, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error('Mock check cancelled.')); return; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => { clearTimeout(timer); reject(new Error('Mock check cancelled.')); };
        signal.addEventListener('abort', cancel, { once: true });
        if (result === 'timeout') return;
        timer = setTimeout(() => {
          signal.removeEventListener('abort', cancel);
          if (result === 'error') { reject(new Error('Offline mock: simulated technical failure.')); return; }
          resolve({ status: result, message: result === 'clear' ? 'Offline mock: clear response. Review the draft and send when ready.' : result === 'warn' ? 'Offline mock: warning response. Review before choosing to send.' : 'Offline mock: insufficient information. Review before choosing to send.', evidenceIds: [] });
        }, delayMs);
      });
    },
  };
}
