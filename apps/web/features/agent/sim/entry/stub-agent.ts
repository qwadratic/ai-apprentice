// A STUB AGENT: a test double for the voice agent, so the simulation can run end to end without ElevenLabs, a brain or a
// network. It is NOT the real agent and the page says so. It does the two things the persona driver needs from an agent:
//   - at a natural pause (no input for QUIET_MS) after something visible happened, it "asks" a fixed question: it tells
//     the driver the agent is speaking, waits as long as speech would take, and calls driver.onAgentAsk(topic, text);
//   - for the workspace's Preview check it answers with a fixed rule (Teach mode only), through a CheckpointPort.
// The questions are plain paraphrases of the brain's templates. The live-stack run replaces this module with the shell.
import type { Clock } from '../clock.ts';
import type { PersonaDriver } from '../driver.ts';

export interface StubWorkspaceView {
  orderId: string;
  customer: string | null;
  address: string;
  window: string;
  body: string;
  attachments: number;
  /** The check status the workspace shows: idle, pending, clear, warn, unknown, error. */
  check: string;
  caseId: string;
}

export interface StubAgentLog {
  atMs: number;
  text: string;
}

export interface StubAgentOptions {
  mode: 'learn' | 'teach';
  driver: Pick<PersonaDriver, 'onAgentAsk' | 'setAgentSpeaking'>;
  clock: Clock;
  view(): StubWorkspaceView;
  log(entry: StubAgentLog): void;
  /** How long the agent "speaks" a question, in ms. */
  speakMs?: number;
  /** How long the desktop must be quiet before the agent asks. */
  quietMs?: number;
}

export interface StubAgent {
  /** The workspace reported typing or a click happened: the desktop is not quiet. */
  noteActivity(): void;
  start(): void;
  stop(): void;
  /** The Preview check for the workspace's CheckpointPort. */
  evaluate(): { status: 'clear' | 'warn' | 'unknown'; message: string };
  readonly asked: ReadonlyArray<{ topic: string; text: string }>;
}

interface Candidate {
  key: string;
  topic: string;
  text: string;
}

export function createStubAgent(options: StubAgentOptions): StubAgent {
  const { clock, driver } = options;
  const speakMs = options.speakMs ?? 2500;
  const quietMs = options.quietMs ?? 3500;
  const asked: Array<{ topic: string; text: string }> = [];
  const done = new Set<string>();
  let running = false;
  let busy = false;
  let lastActivityAt = clock.now();
  let previous: StubWorkspaceView | null = null;
  const pending: Candidate[] = [];

  const queue = (c: Candidate): void => {
    if (done.has(c.key) || pending.some((p) => p.key === c.key)) return;
    pending.push(c);
  };

  const watch = (now: StubWorkspaceView): void => {
    const before = previous;
    previous = now;
    if (before === null) return;
    if (options.mode === 'learn') {
      if (before.attachments > 0 && now.attachments === 0) {
        queue({ key: `removed:${now.orderId}`, topic: 'reason', text: 'I noticed you took the image attachment off this email. What made you do that?' });
      }
      if (now.body !== before.body && now.address !== '' && now.body.includes(now.address) && now.body.includes(now.window)) {
        queue({ key: `typed:${now.orderId}`, topic: 'essentials', text: `You typed details from ${now.orderId} into your message. Which of those details matter most, and why?` });
      }
      if (before.check === 'idle' && now.check !== 'idle') {
        queue({ key: `preview:${now.orderId}`, topic: 'guardrail', text: 'Before you press Send: is there anything that would make you stop and check with someone first, and who would that be?' });
      }
    } else {
      if (before.caseId !== now.caseId) {
        queue({ key: `case:${now.caseId}`, topic: 'predict', text: `What will you do with the email for ${now.orderId}, and why?` });
      }
      if (before.check !== 'warn' && now.check === 'warn') {
        queue({ key: `warn:${now.orderId}`, topic: 'why_hold', text: 'The expert would stop here. Why do you think?' });
      }
    }
  };

  const ask = async (c: Candidate): Promise<void> => {
    busy = true;
    done.add(c.key);
    options.log({ atMs: clock.now(), text: `STUB AGENT asks (${c.topic}): ${c.text}` });
    asked.push({ topic: c.topic, text: c.text });
    driver.setAgentSpeaking(true);
    await clock.sleep(speakMs);
    driver.setAgentSpeaking(false);
    await driver.onAgentAsk(c.topic, c.text);
    // After the exchange the desktop counts as quiet only from now on.
    lastActivityAt = clock.now();
    busy = false;
  };

  const loop = async (): Promise<void> => {
    while (running) {
      await clock.sleep(250);
      if (!running) break;
      watch(options.view());
      const next = pending[0];
      if (next && !busy && clock.now() - lastActivityAt >= quietMs) {
        pending.shift();
        await ask(next);
      }
    }
  };

  return {
    noteActivity() {
      lastActivityAt = clock.now();
    },
    start() {
      if (running) return;
      running = true;
      previous = options.view();
      void loop();
    },
    stop() {
      running = false;
    },
    evaluate() {
      const v = options.view();
      if (options.mode === 'teach' && v.customer === 'customer_07' && v.attachments > 0 && !v.body.includes(v.address)) {
        return {
          status: 'warn',
          message: 'STUB TUTOR (test double): for this customer the details have to be written in the text, not only in the picture.',
        };
      }
      return { status: 'clear', message: 'STUB TUTOR (test double): nothing to hold back.' };
    },
    get asked() {
      return asked;
    },
  };
}
