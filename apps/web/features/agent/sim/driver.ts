// The persona driver: a synthetic person that works in the workspace and answers the agent by voice.
//
//   createPersonaDriver({ persona, workspace, mic, onLog })
//     .onAgentAsk(topic, text)   the agent asked something: think for a human moment, then play the matching clip
//     .setAgentSpeaking(bool)    the agent is talking: hold still, never talk over it
//     .run(task)                 run a scripted task (tasks.ts) in the workspace
//
// Answers are cued by the agent's questions and never placed on a timeline. A question about a topic the persona has no
// answer for gets an honest "I'm not sure" clip, never an invented fact. The persona's knowledge lives in personas.ts and
// is spoken, not injected: the agent has to ask for it.
import { createRng, jittered } from './clock.ts';
import type { Clock } from './clock.ts';
import { pickLine } from './personas.ts';
import type { Persona } from './personas.ts';
import { MicStoppedError } from './synthetic-mic.ts';
import type { SyntheticMic } from './synthetic-mic.ts';
import type { TaskScript, TaskStep } from './tasks.ts';
import type { CheckStatus, WorkspaceActions } from './workspace-actions.ts';

export type DriverLogKind =
  | 'ask'
  | 'answer_start'
  | 'answer_end'
  | 'answer_cancelled'
  | 'agent_speaking'
  | 'step'
  | 'check'
  | 'note'
  | 'error';

export interface DriverLog {
  /** Milliseconds on the driver's clock. */
  atMs: number;
  kind: DriverLogKind;
  text: string;
  data?: Record<string, string | number | boolean | null>;
}

export interface AnsweredQuestion {
  topic: string;
  question: string;
  clipId: string;
  /** false when the persona had no answer keyed for the topic and played its "not sure" clip. */
  known: boolean;
  startedAtMs: number;
  endedAtMs: number;
}

export interface TaskReport {
  taskId: string;
  completed: boolean;
  stepsRun: number;
  sent: boolean;
  /** Every check status the persona saw after pressing Preview, in order. */
  checks: CheckStatus[];
}

export interface PersonaDriverOptions {
  persona: Persona;
  workspace: WorkspaceActions;
  mic: Pick<SyntheticMic, 'say'>;
  onLog?: (entry: DriverLog) => void;
  clock: Clock;
  rng?: () => number;
  /** Multiplies the think time before a spoken answer (1 = as written in the persona). */
  thinkScale?: number;
  /** The longest the persona waits for the agent to finish talking before it answers anyway. */
  maxWaitForAgentMs?: number;
}

export interface PersonaDriver {
  readonly persona: Persona;
  /**
   * The agent asked a question. `caseKey` picks a case-specific answer (predict@new-image); by default it is the case the
   * persona opened last. Resolves when the answer has been played (or skipped because the driver was stopped).
   */
  onAgentAsk(topic: string, text: string, options?: { caseKey?: string }): Promise<void>;
  setAgentSpeaking(speaking: boolean): void;
  setCase(caseKey: string | null): void;
  run(task: TaskScript): Promise<TaskReport>;
  stop(): void;
  readonly answered: readonly AnsweredQuestion[];
  isBusy(): boolean;
}

const POLL_MS = 100;
const CHECK_TIMEOUT_MS = 30_000;

export function createPersonaDriver(options: PersonaDriverOptions): PersonaDriver {
  const { persona, workspace, mic, clock } = options;
  const rng = options.rng ?? createRng(11);
  const thinkScale = options.thinkScale ?? 1;
  const maxWaitForAgentMs = options.maxWaitForAgentMs ?? 20_000;
  const log = (kind: DriverLogKind, text: string, data?: DriverLog['data']): void => {
    const entry: DriverLog = { atMs: clock.now(), kind, text };
    if (data) entry.data = data;
    options.onLog?.(entry);
  };

  let stopped = false;
  let agentSpeaking = false;
  let lastAgentSpeechAtMs = -1;
  /** Questions asked and not yet answered or cancelled (queued + the one being answered). */
  let pendingAnswers = 0;
  let answerTail: Promise<void> = Promise.resolve();
  let caseKey: string | null = null;
  /** Reset at every open and Preview: "did the agent speak since then" is what `react` asks. */
  let markAtMs = 0;
  const occurrences = new Map<string, number>();
  const answered: AnsweredQuestion[] = [];

  const busy = (): boolean => agentSpeaking || pendingAnswers > 0;

  /** Waits until `done()` is true or `maxMs` has passed on the clock; resolves whether it became true. */
  const waitFor = async (done: () => boolean, maxMs: number): Promise<boolean> => {
    const until = clock.now() + maxMs;
    while (!done()) {
      if (stopped || clock.now() >= until) return done();
      await clock.sleep(POLL_MS);
    }
    return true;
  };

  const answer = async (topic: string, question: string, key: string | null): Promise<void> => {
    // Never talk over the agent: a question is answered after the agent has finished saying it.
    await waitFor(() => !agentSpeaking, maxWaitForAgentMs);
    if (stopped) return;
    const count = occurrences.get(`${topic}@${key ?? ''}`) ?? 0;
    occurrences.set(`${topic}@${key ?? ''}`, count + 1);
    const picked = pickLine(persona, topic, key, count);
    if (!picked.known) log('note', `no answer keyed for "${topic}": the persona says it is not sure`, { topic });
    await clock.sleep(jittered(rng, picked.line.thinkMs * thinkScale, 0.25));
    if (stopped) return;
    const startedAtMs = clock.now();
    log('answer_start', picked.line.text, { topic, clipId: picked.clipId, known: picked.known });
    try {
      await mic.say(picked.clipId);
    } catch (error) {
      if (error instanceof MicStoppedError) {
        log('answer_cancelled', picked.line.text, { topic, clipId: picked.clipId });
        return;
      }
      log('error', `the clip ${picked.clipId} could not be played: ${error instanceof Error ? error.message : String(error)}`, { topic });
      return;
    }
    answered.push({ topic, question, clipId: picked.clipId, known: picked.known, startedAtMs, endedAtMs: clock.now() });
    log('answer_end', picked.line.text, { topic, clipId: picked.clipId });
  };

  const enqueueAnswer = (topic: string, question: string, key: string | null): Promise<void> => {
    pendingAnswers += 1;
    // One answer at a time, in the order the questions came.
    const result = answerTail.then(() => answer(topic, question, key)).finally(() => {
      pendingAnswers -= 1;
    });
    answerTail = result.catch(() => undefined);
    return result;
  };

  const onAgentAsk = (topic: string, text: string, askOptions?: { caseKey?: string }): Promise<void> => {
    if (stopped) return Promise.resolve();
    lastAgentSpeechAtMs = clock.now();
    log('ask', text, { topic });
    return enqueueAnswer(topic, text, askOptions?.caseKey ?? caseKey);
  };

  const expand = (template: string): string => {
    const order = workspace.readOrder();
    return template
      .replaceAll('{orderId}', order.orderId)
      .replaceAll('{customer}', order.customer ?? '')
      .replaceAll('{address}', order.address)
      .replaceAll('{window}', order.window);
  };

  const state = { steps: 0, checks: [] as CheckStatus[] };

  const runStep = async (step: TaskStep): Promise<void> => {
    if (stopped) return;
    state.steps += 1;
    log('step', step.do, step.do === 'open' ? { case: step.case } : undefined);
    switch (step.do) {
      case 'open':
        await workspace.openOrder(step.case);
        caseKey = step.case;
        markAtMs = clock.now();
        return;
      case 'look':
        await clock.sleep(jittered(rng, step.ms, 0.15));
        return;
      case 'pause': {
        const startedAtMs = clock.now();
        await clock.sleep(jittered(rng, step.ms, 0.1));
        // The agent may start talking only now (it needs a moment to notice the pause): give it a grace period.
        if (!busy() && (step.graceMs ?? 0) > 0) await waitFor(() => busy() || lastAgentSpeechAtMs >= startedAtMs, step.graceMs ?? 0);
        // Then wait until the agent has finished and the persona has finished its answer.
        await waitFor(() => !busy(), maxWaitForAgentMs * 2);
        // A beat after the conversation before the next action, like a person.
        if (lastAgentSpeechAtMs >= startedAtMs) await clock.sleep(jittered(rng, 900, 0.3));
        return;
      }
      case 'remove_image':
        await workspace.removeImage();
        return;
      case 'attach_image':
        await workspace.attachImage();
        return;
      case 'type':
        await workspace.typeText(step.target, expand(step.text), step.mode);
        return;
      case 'preview': {
        markAtMs = clock.now();
        await workspace.preview();
        const result = await workspace.waitForCheck(CHECK_TIMEOUT_MS);
        state.checks.push(result.status);
        log('check', result.message, { status: result.status });
        return;
      }
      case 'ack':
        await workspace.acknowledge();
        return;
      case 'send':
        log('note', (await workspace.send()) ? 'sent' : 'send was not possible');
        return;
      case 'resolve':
        await workspace.resolveTicket();
        return;
      case 'react':
        // A reaction to what the agent said, not an answer to a question: no 'ask' is logged.
        if (lastAgentSpeechAtMs >= markAtMs) await enqueueAnswer(step.topic, '', caseKey);
        return;
      case 'if_check': {
        const status = workspace.checkResult().status;
        const branch = step.status.includes(status) ? step.then : (step.else ?? []);
        for (const inner of branch) await runStep(inner);
        return;
      }
    }
  };

  return {
    persona,
    onAgentAsk,
    setAgentSpeaking(speaking) {
      if (speaking === agentSpeaking) return;
      agentSpeaking = speaking;
      if (speaking) lastAgentSpeechAtMs = clock.now();
      log('agent_speaking', speaking ? 'the agent started talking' : 'the agent stopped talking', { speaking });
    },
    setCase(key) {
      caseKey = key;
    },
    async run(task) {
      state.steps = 0;
      state.checks = [];
      log('note', `task ${task.id}: ${task.title}`);
      let completed = false;
      try {
        for (const step of task.steps) await runStep(step);
        completed = !stopped;
      } catch (error) {
        log('error', error instanceof Error ? error.message : String(error));
        throw error;
      }
      return { taskId: task.id, completed, stepsRun: state.steps, sent: workspace.isSent(), checks: [...state.checks] };
    },
    stop() {
      stopped = true;
    },
    get answered() {
      return answered;
    },
    isBusy: busy,
  };
}
