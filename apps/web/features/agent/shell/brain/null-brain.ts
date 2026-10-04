import type { ActionCheckpoint, CheckpointReply, ScreenObservation, ScreenStatus } from '@apprentice/contracts';
import type { AnswerInput, Brain, BrainDecision, ReviewOutput, TranscriptTurn } from './types.ts';

/**
 * The brain that is wired until TASK-3.29 lands. It logs what it receives, never asks, never defers and never
 * says "clear": a checkpoint is answered `unknown` so that nothing is ever presented as judged.
 */
export class NullBrain implements Brain {
  readonly name = 'NullBrain';
  readonly wired = false;
  private readonly log: (line: string) => void;
  private seen = 0;
  private reported = 0;

  constructor(log: (line: string) => void = () => {}) {
    this.log = log;
  }

  onObservation(o: ScreenObservation): void {
    this.seen += 1;
    this.log(`observation ${o.kind} #${o.sequence} (${o.id})`);
  }

  onStatus(s: ScreenStatus): void {
    this.log(`screen status ${s.state}${s.reason ? ` (${s.reason})` : ''}`);
  }

  onTranscript(t: TranscriptTurn): void {
    this.log(`transcript ${t.role}: ${t.text.length} characters`);
  }

  tick(_nowMs?: number): BrainDecision[] {
    if (this.seen === this.reported) return [];
    const fresh = this.seen - this.reported;
    this.reported = this.seen;
    return [{
      decision: 'SKIP',
      topic: 'no_policy',
      kind: 'none',
      whyNow: `${fresh} new event${fresh === 1 ? '' : 's'}; no question policy is wired in this build, so nothing is asked.`,
      evidenceIds: [],
    }];
  }

  onAnswer(a: AnswerInput): void {
    this.log(`${a.kind}: ${a.text.length} characters`);
  }

  review(): ReviewOutput {
    return { gaps: [], teachBack: null, map: { steps: [] } };
  }

  checkpoint(c: ActionCheckpoint): CheckpointReply {
    this.log(`checkpoint ${c.id}`);
    return {
      schemaVersion: 1,
      checkpointId: c.id,
      status: 'unknown',
      message: 'Not judged: no tutor is wired in this build. Ask the expert before you send.',
      evidenceIds: [],
      basedOn: { order: c.revisions.order, email: c.revisions.email },
    };
  }
}
