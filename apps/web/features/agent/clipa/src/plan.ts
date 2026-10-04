/*
 * From a BrainDecision to the sequence of director commands. Pure, so it is unit-tested in node.
 *
 *   ASK_NOW / PREDICT  clipa.state "approach" (default): approach the target, say the utterance, listen.
 *   WARN               clipa.state "warning" (default): fly beside the target (Send) in warning pose, say it.
 *   DEFER / SKIP       no movement at all: the question is queued or dropped by the brain, Clipa stays put.
 * An explicit clipa.state wins over the default of the verdict: "pointing" points at the target (the
 * replay of the expert's moment), "speaking" speaks in place, "retreat"/"dock" goes home, "off" sleeps.
 */
import type { BrainVerdict, ClipaDecision, ClipaStep, ClipaState } from './types.ts';

const VERDICTS: readonly BrainVerdict[] = ['ASK_NOW', 'DEFER', 'SKIP', 'WARN', 'PREDICT'];

export interface DecisionPlan {
  steps: ClipaStep[];
  /** Why the plan is empty or was adjusted; for the log. */
  note?: string;
}

export function utteranceText(utterance: ClipaDecision['utterance']): string | null {
  const text = typeof utterance === 'string' ? utterance : utterance?.text;
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

/** How long Clipa's mouth moves for a text when no voice reports it: about 360 ms a word, 1.2-14 s. */
export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(14000, Math.max(1200, 400 + words * 360));
}

export function planDecision(decision: ClipaDecision): DecisionPlan {
  const verdict: unknown = decision.decision;
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as BrainVerdict)) {
    return { steps: [], note: `unknown decision ${JSON.stringify(verdict)}` };
  }
  if (decision.decision === 'DEFER' || decision.decision === 'SKIP') {
    return { steps: [], note: `${decision.decision}: Clipa stays where she is` };
  }

  const text = utteranceText(decision.utterance);
  const target = decision.clipa?.target;
  const wantsAnswer = decision.expectsAnswer ?? decision.decision !== 'WARN';
  const state: ClipaState =
    decision.clipa?.state ?? (decision.decision === 'WARN' ? 'warning' : 'approach');
  const steps: ClipaStep[] = [];
  let note: string | undefined;

  const speakAndListen = (): void => {
    if (text) steps.push({ op: 'speak', text });
    if (text && wantsAnswer) steps.push({ op: 'listen' });
  };

  switch (state) {
    case 'notice':
      if (target) steps.push({ op: 'notice', target });
      else note = 'notice needs a target';
      break;
    case 'approach':
      if (target) steps.push({ op: 'approach', target });
      else if (text) note = 'no target: speaking in place';
      speakAndListen();
      break;
    case 'speaking':
      speakAndListen();
      break;
    case 'listening':
      steps.push({ op: 'listen' });
      break;
    case 'thinking':
      steps.push({ op: 'think' });
      break;
    case 'ack':
      steps.push({ op: 'ack' });
      break;
    case 'warning':
      steps.push(target ? { op: 'warn', target } : { op: 'warn' });
      if (text) steps.push({ op: 'speak', text });
      break;
    case 'pointing':
      steps.push(target ? { op: 'point', target } : { op: 'point' });
      if (text) steps.push({ op: 'speak', text });
      break;
    case 'dock':
    case 'retreat':
      steps.push({ op: 'retreat' });
      break;
    case 'off':
      steps.push({ op: 'off' });
      break;
  }
  return note === undefined ? { steps } : { steps, note };
}
