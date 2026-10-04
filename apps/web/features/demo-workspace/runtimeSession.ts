import type {SessionStart} from '@apprentice/contracts';

/** One app session owns one timeline, including time spent before choosing a screen. */
export function bindWorkspaceSession(configured: SessionStart | (() => SessionStart)) {
  const provider = typeof configured === 'function' ? configured : () => configured;
  const initial = structuredClone(provider());
  if (!initial.sessionId.trim() || !Number.isSafeInteger(initial.sessionEpochMs) || initial.sessionEpochMs < 0) {
    throw new TypeError('A prepared screen session is required.');
  }
  return {
    session: structuredClone(initial),
    atCapture(): SessionStart {
      const current = provider();
      if (current.sessionId !== initial.sessionId || current.sessionEpochMs !== initial.sessionEpochMs) {
        throw new Error('The app session changed. Prepare a new session and recreate the workspace.');
      }
      return structuredClone(initial);
    },
  };
}
