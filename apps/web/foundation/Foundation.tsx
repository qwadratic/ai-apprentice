import { useEffect, useRef, useState } from 'react';
import { CONTRACT_REVIEW_STATUS, MockScreenBridge } from '@apprentice/contracts';
import type { ScreenObservation, ScreenStatus } from '@apprentice/contracts';
export function Foundation() {
  const bridge = useRef(new MockScreenBridge()).current;
  const clock = useRef(0);
  const [status, setStatus] = useState<ScreenStatus['state']>('stopped');
  const [observations, setObservations] = useState<ScreenObservation[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const observation = bridge.onObservation((o) => setObservations((old) => [...old, o]));
    const state = bridge.onStatus((s) => setStatus(s.state));
    return () => { observation(); state(); void bridge.stop(); };
  }, [bridge]);
  const run = (command: () => Promise<void>) => { setError(''); void command().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Command failed')); };
  return <main style={{fontFamily: 'system-ui', maxWidth: 900, margin: '40px auto', padding: 20}}>
    <h1>AI Apprentice: foundation check</h1>
    <p>Synthetic mock only. No screen capture, recording, voice or tutor is connected.</p>
    <p>ScreenBridge v1 review: {CONTRACT_REVIEW_STATUS}. State: <strong>{status}</strong>.</p>
    <button onClick={() => run(async () => { setObservations([]); await bridge.start({sessionId: `synthetic-${clock.current}`, sessionEpochMs: clock.current}); })}>Start mock</button>{' '}
    <button disabled={status !== 'capturing'} onClick={() => run(() => bridge.pause())}>Pause</button>{' '}
    <button disabled={status !== 'paused'} onClick={() => run(() => bridge.resume())}>Resume</button>{' '}
    <button onClick={() => run(() => bridge.stop())}>Stop</button>{' '}
    <button onClick={() => { clock.current += 1000; bridge.advanceTo(clock.current); }}>Advance clock 1 second</button>
    {error && <p role="alert">{error}</p>}
    <p>Advance while paused to verify skipped events and unchanged session time.</p>
    <pre style={{whiteSpace: 'pre-wrap'}}>{JSON.stringify(observations, null, 2)}</pre>
  </main>;
}
