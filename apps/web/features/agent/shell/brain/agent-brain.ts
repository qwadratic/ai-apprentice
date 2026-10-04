// The real brain of the shell: an adapter from the shell's Brain seam (brain/types.ts) to packages/agent.
// packages/agent decides (ConversationPolicy), keeps the Work Map (reduceMap), runs the debrief (planFollowUps, teach-back)
// and judges a checkpoint (tutor). This file only translates: observations in, BrainDecisions out, answers to the map, and
// a CheckpointReply for the workspace. Nothing about the customer rule is written here; it all comes from the expert's answers.
//
// Models: when the session has an LLM route, the extractor, the reply classifier and the entity resolver call it through one
// LlmClient (queued, one call at a time). Any failure falls back to the heuristics inside packages/agent, and the client's
// events (task, outcome, reason; never the text) reach the log through `log`.
import type { ActionCheckpoint, CheckpointReply, ScreenObservation, ScreenStatus } from '@apprentice/contracts';
import {
  ConversationPolicy, HeuristicAnswerExtractor, HeuristicReplyClassifier, LlmAnswerExtractor, LlmEntityResolver, LlmReplyClassifier,
  MAX_FOLLOW_UPS, ReviewClarifier, applyTeachBackReply, buildPrediction, checkpoint as judgeCheckpoint, createMapState,
  evaluatePrediction, knownCustomerRefs, labelFacts, latestConfirmed, planFollowUps, pressReviewButton, reduceMap, reviewStatus, stateTeachBack,
  summarizeMastery, workingMap,
} from '@apprentice/agent';
import type {
  AnswerExtractor, BrainDecision as PolicyDecision, CaseOutcome, MapState, Prediction, Question, ReplyClassifier, ReplyVerdict, TeachBack,
  WorkMap,
} from '@apprentice/agent';
import type { Mode } from '../state/types.ts';
import type {
  AnswerInput, AnswerResult, Brain, BrainDecision, BrainSession, BrainSignals, ClipaTargetRef, DraftMap, DraftStep, GuardrailRef,
  MasteryLines, ReviewOutput, TranscriptTurn,
} from './types.ts';

const REVIEW_GAP_MS = 1500;
/** Learn says why it is not asking at most this often (a SKIP line in the decision log; never spoken). */
export const WAITING_NOTE_MS = 20_000;
/** A typing heartbeat built from the page's own input events counts as typing for this long after the last key. */
const PAGE_TYPING_MS = 2000;
/** A question that did not reach the person is not asked again for this long. */
export const NOT_SPOKEN_BACKOFF_MS = 10_000;
const MAX_OBSERVATIONS = 300;

/** What the topic of a question is called in the shell's decision log. */
const TOPIC_KIND: Readonly<Record<string, string>> = {
  reason: 'reason',
  essentials: 'essentials',
  guardrail: 'stop_and_ask',
  scope: 'scope',
  exception: 'exception',
  why_stop: 'stop_and_ask',
  duration: 'duration',
  ticket_note: 'note',
  predict_next: 'predict',
  checkpoint: 'checkpoint',
  teach_back: 'teach_back',
};

/** Where Clipa goes for a Learn question, by what changed on screen. The surfaces are the workspace's (order, email, ticket). */
const CANDIDATE_TARGET: Readonly<Record<string, ClipaTargetRef>> = {
  attachment_removed: { surface: 'email', hint: 'attachments' },
  attachment_added: { surface: 'email', hint: 'attachments' },
  body_text_why: { surface: 'email', hint: 'body' },
  body_text_added: { surface: 'email', hint: 'body' },
  recipient_changed: { surface: 'email', hint: 'recipient' },
  preview_opened: { surface: 'email', hint: 'preview' },
  ticket_done: { surface: 'ticket' },
  decision_point: { surface: 'order' },
};

export const SEND_TARGET: ClipaTargetRef = { surface: 'email', hint: 'send' };

type OpenQuestion =
  | { kind: 'learn'; questionId: string; question: Question }
  | { kind: 'followup'; questionId: string; question: Question }
  | { kind: 'teachback'; questionId: string; heard: TeachBack }
  | { kind: 'predict'; questionId: string; prediction: Prediction };

interface TeachProgress {
  caseId: string;
  title: string;
  prediction: Prediction | null;
  verdict: CaseOutcome['verdict'] | null;
  firstStatus: CaseOutcome['firstStatus'] | null;
}

export interface AgentBrainOptions {
  /** One line for the debug log. Never a token or a transcript. */
  log(line: string): void;
  /** The customers the workspace knows: what a spoken "customer seven" can be resolved to. */
  customers: readonly string[];
}

const keyOf = (q: Question): string => `${q.topic}:${q.targetId ?? q.entityRef ?? ''}`;

function errMsg(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

export class AgentBrain implements Brain {
  readonly name = 'AgentBrain (packages/agent)';
  readonly wired = true;

  private readonly options: AgentBrainOptions;
  private mode: Mode = 'learn';
  private persona: BrainSession['persona'] = 'plain';
  private sessionId = '';
  private nowMs = 0;
  private state: MapState;
  private policy: ConversationPolicy | null = null;
  private learnPolicy: ConversationPolicy | null = null;
  private observations: ScreenObservation[] = [];
  private extractor: AnswerExtractor = new HeuristicAnswerExtractor();
  private classifier: ReplyClassifier = new HeuristicReplyClassifier();
  private outbox: BrainDecision[] = [];
  private open: OpenQuestion | null = null;
  private busy = false;
  private lastAnsweredAtMs: number | null = null;
  // Review
  private asked = new Set<string>();
  private reviewSeq = 0;
  /** No question is asked before this session time: a question that did not reach the person is not re-asked at once. */
  private holdUntilMs = 0;
  /** The Work Map was built from the sample source (invented data), not from the person's screen. */
  private mapSynthetic = false;
  private clarifier = new ReviewClarifier();
  /** The teach-back last said to the expert (the one a spoken reply answers); null before the first. */
  private heard: TeachBack | null = null;
  /** The review gave up understanding the expert: the buttons are shown and the teach-back is not asked again until one is pressed. */
  private buttons = false;
  private reviewClosed = false;
  private reviewHalted = false;
  // Teach
  private teach: TeachProgress | null = null;
  private outcomes: CaseOutcome[] = [];
  private notJudged: Array<{ caseId: string; title: string; why: string }> = [];
  /** Last page input fed to the policy (session ms), and the last "why no question" note. */
  private fedInputAtMs = Number.NEGATIVE_INFINITY;
  private pageInputSeq = 0;
  private waitingNote: { atMs: number; text: string } | null = null;
  private lastLearnDecisionAtMs = 0;
  private emptyNoted = false;

  constructor(options: AgentBrainOptions) {
    this.options = options;
    this.state = createMapState(options.customers);
  }

  // ---- session ------------------------------------------------------------

  /** The source of observations changed: Learn builds its map from it, and the map says whether that was the sample. */
  setSource(synthetic: boolean): void {
    if (this.mode === 'learn') this.mapSynthetic = synthetic;
  }

  begin(session: BrainSession): void {
    this.mode = session.mode;
    this.persona = session.persona;
    this.sessionId = session.sessionId;
    this.nowMs = 0;
    this.observations = [];
    this.outbox = [];
    this.open = null;
    this.busy = false;
    this.lastAnsweredAtMs = null;
    this.asked = new Set();
    this.holdUntilMs = 0;
    this.fedInputAtMs = Number.NEGATIVE_INFINITY;
    this.waitingNote = null;
    this.lastLearnDecisionAtMs = 0;
    this.emptyNoted = false;
    this.clarifier = new ReviewClarifier();
    this.heard = null;
    this.buttons = false;
    this.reviewClosed = false;
    this.reviewHalted = false;
    this.teach = null;

    const llm = session.llm;
    if (llm) {
      const resolver = new LlmEntityResolver({ client: llm });
      this.extractor = new LlmAnswerExtractor({ client: llm, resolver });
      this.classifier = new LlmReplyClassifier({ client: llm });
      this.options.log('Model-backed extraction, reply reading and customer resolution on; any failure falls back to heuristics.');
    } else {
      this.extractor = new HeuristicAnswerExtractor();
      this.classifier = new HeuristicReplyClassifier();
      this.options.log('No LLM route for this session: heuristic extraction and reply reading.');
    }

    const now = (): number => this.nowMs;
    if (session.mode === 'learn') {
      this.state = createMapState(this.options.customers);
      this.outcomes = [];
      this.notJudged = [];
      this.mapSynthetic = false;
      this.policy = new ConversationPolicy({ mode: 'learn', persona: session.persona, now });
      this.learnPolicy = this.policy;
    } else if (session.mode === 'teach') {
      this.policy = new ConversationPolicy({ mode: 'teach', persona: session.persona, now });
      this.policy.setMap(latestConfirmed(this.state));
      this.teach = { caseId: session.caseId ?? 'case', title: session.caseTitle ?? 'Sample case', prediction: null, verdict: null, firstStatus: null };
      const confirmed = latestConfirmed(this.state);
      this.options.log(confirmed ? `Teach reads Work Map version ${confirmed.version} (confirmed).` : 'Teach has no confirmed Work Map: every checkpoint will be unknown.');
    } else {
      this.policy = null;
    }
  }

  // ---- inputs -------------------------------------------------------------

  onObservation(o: ScreenObservation): void {
    this.observations.push(o);
    if (this.observations.length > MAX_OBSERVATIONS) this.observations.shift();
    try {
      this.policy?.observe(o);
      if (this.mode === 'learn') this.state = reduceMap(this.state, { type: 'observation', observation: o });
    } catch (e) {
      this.options.log(`observation ${o.kind} could not be used: ${errMsg(e)}`);
    }
  }

  /** Page key presses reach the policy's typing channel as heartbeats (a no-op when the workspace's own ones already arrived). */
  private feedPageInput(policy: ConversationPolicy, nowMs: number, lastInputAtMs: number | null): void {
    if (lastInputAtMs === null || lastInputAtMs <= this.fedInputAtMs || this.mode === 'review') return;
    const last = Math.min(lastInputAtMs, nowMs);
    this.fedInputAtMs = lastInputAtMs;
    const heartbeat = {
      schemaVersion: 1, id: `page-input-${++this.pageInputSeq}`, sessionId: this.sessionId, sequence: 0, timestampMs: nowMs,
      source: 'workspace', frameId: null, sourceRevision: null, entityRef: null, evidenceIds: [], kind: 'input_activity',
      facts: { surface: 'email', typing: nowMs - last < PAGE_TYPING_MS, lastInputAtMs: last, idleMs: nowMs - last },
    } as unknown as ScreenObservation;
    try { policy.observe(heartbeat); } catch (e) { this.options.log(`page input could not be used: ${errMsg(e)}`); }
  }

  /** Why Learn asks nothing right now, in plain words. */
  private whyNoQuestion(policy: ConversationPolicy): string {
    const pending = policy.candidates.filter((c) => c.state === 'pending').length;
    const seen = this.observations.filter((o) => o.kind !== 'input_activity').length;
    if (pending > 0) return `${pending} question${pending === 1 ? '' : 's'} wait for a natural pause`;
    if (seen === 0) return 'no screen observation has arrived yet (share the window with the demo workspace)';
    return `${seen} screen observation${seen === 1 ? '' : 's'}, and no change worth a question yet. Clipa asks when an attachment is removed or added, the recipient changes, the order details are typed into the message, Preview opens or the ticket is closed`;
  }

  /** A SKIP line for the decision log that says why nothing is asked, at most every WAITING_NOTE_MS and only after a quiet stretch. */
  private waiting(nowMs: number, why: string): BrainDecision[] {
    if (this.mode !== 'learn') return [];
    const note = this.waitingNote;
    if (nowMs - this.lastLearnDecisionAtMs < WAITING_NOTE_MS) return [];
    if (note !== null && nowMs - note.atMs < WAITING_NOTE_MS) return [];
    this.waitingNote = { atMs: nowMs, text: why };
    return [{
      decision: 'SKIP', topic: 'waiting', kind: 'waiting', evidenceIds: [], whyNow: `No question yet: ${why}.`, expectsAnswer: false,
    }];
  }

  onStatus(s: ScreenStatus): void {
    this.options.log(`screen status ${s.state}${s.reason ? ` (${s.reason})` : ''}`);
  }

  onTranscript(t: TranscriptTurn): void {
    if (t.role !== 'user') return;
    // A final transcript means the phrase just ended: the human channel is quiet from here for its threshold.
    this.policy?.humanSpeech(true, t.atMs);
    this.policy?.humanSpeech(false, t.atMs);
  }

  // ---- the loop -----------------------------------------------------------

  tick(nowMs: number, signals?: BrainSignals): BrainDecision[] {
    this.nowMs = nowMs;
    if (signals) {
      this.policy?.agentSpeech(signals.agentSpeaking);
      this.policy?.humanSpeech(signals.humanSpeaking, nowMs);
      this.policy?.setOffRecord(signals.offRecord, nowMs);
    }
    const out: BrainDecision[] = this.outbox.splice(0);
    if (signals?.offRecord) return out;
    if (this.mode === 'review') return [...out, ...this.reviewTick(nowMs, signals)];
    const policy = this.policy;
    if (policy === null) return out;
    this.feedPageInput(policy, nowMs, signals?.lastInputAtMs ?? null);
    // Nothing is asked while the voice is not connected (it would only pile up "not spoken" items), and a question that did not
    // reach the person waits before it is asked again. Candidates stay in the policy's queue (and age into Review).
    if (signals !== undefined && !signals.voiceConnected) return [...out, ...this.waiting(nowMs, 'the voice is not connected, so Clipa cannot ask; questions wait in the queue')];
    if (nowMs < this.holdUntilMs) return out;
    for (const d of policy.tick(nowMs)) out.push(this.fromPolicy(d, policy));
    if (this.mode === 'learn') {
      if (out.length > 0) this.lastLearnDecisionAtMs = nowMs;
      else out.push(...this.waiting(nowMs, this.whyNoQuestion(policy)));
    }
    return out;
  }

  private fromPolicy(d: PolicyDecision, policy: ConversationPolicy): BrainDecision {
    const topic = d.topic ?? 'none';
    const base: BrainDecision = { decision: d.decision, topic, kind: TOPIC_KIND[topic] ?? topic, whyNow: d.whyNow, evidenceIds: [...d.evidenceIds] };
    if (d.decision === 'ASK_NOW' && d.question !== null && d.questionId !== null && d.utterance !== null) {
      this.open = { kind: 'learn', questionId: d.questionId, question: d.question };
      const candidate = policy.candidates.find((c) => c.id === d.candidateId);
      const target = candidate ? CANDIDATE_TARGET[candidate.kind] : undefined;
      return {
        ...base, questionId: d.questionId, expectsAnswer: true,
        utterance: { text: d.utterance.text, delivery: d.utterance.delivery, maxWords: d.utterance.maxWords },
        clipa: { state: 'approach', ...(target ? { target } : {}) },
      };
    }
    if (d.decision === 'PREDICT' && d.utterance !== null && d.questionId !== null && d.prediction !== null) {
      this.open = { kind: 'predict', questionId: d.questionId, prediction: d.prediction };
      if (this.teach) this.teach.prediction = d.prediction;
      return {
        ...base, questionId: d.questionId, expectsAnswer: true,
        utterance: { text: d.utterance.text, delivery: d.utterance.delivery, maxWords: d.utterance.maxWords },
        clipa: { state: 'approach', target: CANDIDATE_TARGET['decision_point'] ?? { surface: 'order' } },
      };
    }
    return base;
  }

  /** A spoken decision never reached the person: the question goes back to the policy's queue. */
  onNotSpoken(decision: BrainDecision): void {
    const id = decision.questionId;
    if (id === undefined) return;
    const open = this.open;
    if (open === null || open.questionId !== id) return;
    this.open = null;
    this.holdUntilMs = this.nowMs + NOT_SPOKEN_BACKOFF_MS;
    if (open.kind === 'followup') {
      // The follow-up goes back to the plan: it can be asked again after the back-off.
      this.asked.delete(keyOf(open.question));
    } else if (open.kind === 'learn' || open.kind === 'predict') {
      this.policy?.cancelQuestion(id, this.nowMs);
    }
    // A teach-back that was not spoken was never stated (onSpoken states it), so the next review tick simply plays it again.
  }

  /** A spoken decision reached the voice: a teach-back counts as stated now (the confirmation gate), not when it was only planned. */
  onSpoken(decision: BrainDecision): void {
    const open = this.open;
    if (open === null || open.kind !== 'teachback' || open.questionId !== decision.questionId) return;
    const stated = stateTeachBack(this.state);
    this.state = stated.state;
    this.heard = stated.teachBack;
    open.heard = stated.teachBack;
  }

  // ---- answers ------------------------------------------------------------

  private orderFields(): Record<string, string> {
    const order = this.observations.filter((o) => o.kind === 'order_view').at(-1);
    if (order?.kind !== 'order_view') return {};
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries({ orderId: order.facts.orderId, deliveryAddress: order.facts.deliveryAddress, deliveryWindow: order.facts.deliveryWindow })) {
      if (v !== null && v !== '') fields[k] = v;
    }
    return fields;
  }

  async onAnswer(a: AnswerInput): Promise<AnswerResult | void> {
    if (a.kind === 'confirm') return this.pressButton(a, 'confirm');
    if (a.kind === 'skip') return this.pressButton(a, 'skip');
    if (a.kind === 'correct') return this.reply(a, 'correct');
    const open = this.open;
    if (open === null || this.busy) {
      this.options.log('An answer arrived with no open question: it stays in the transcript only.');
      return undefined;
    }
    this.busy = true;
    try {
      switch (open.kind) {
        case 'learn':
          return await this.learnAnswer(open, a);
        case 'followup':
          return await this.followUpAnswer(open, a);
        case 'teachback':
          return await this.reply(a, null);
        case 'predict':
          return this.predictAnswer(open, a);
      }
    } catch (e) {
      this.options.log(`answer could not be used: ${errMsg(e)}`);
      this.open = null;
      return undefined;
    } finally {
      this.busy = false;
      this.lastAnsweredAtMs = this.nowMs;
    }
  }

  private async extract(question: Question, a: AnswerInput): Promise<void> {
    const extraction = await this.extractor.extract({
      topic: question.topic,
      text: a.text,
      questionId: question.id,
      questionText: question.text,
      atMs: a.atMs,
      evidenceIds: question.evidenceIds,
      targetId: question.targetId,
      entityRef: question.entityRef,
      knownRefs: knownCustomerRefs(this.state),
      orderFields: this.orderFields(),
    });
    this.state = reduceMap(this.state, { type: 'answer', extraction });
    this.options.log(`answer to ${question.topic} added to the Work Map (draft version ${workingMap(this.state).version}).`);
  }

  private async learnAnswer(open: Extract<OpenQuestion, { kind: 'learn' }>, a: AnswerInput): Promise<AnswerResult> {
    await this.extract(open.question, a);
    this.policy?.setMap(workingMap(this.state));
    this.policy?.finishQuestion(open.questionId, a.atMs);
    this.open = null;
    return { changed: true };
  }

  private async followUpAnswer(open: Extract<OpenQuestion, { kind: 'followup' }>, a: AnswerInput): Promise<AnswerResult> {
    await this.extract(open.question, a);
    this.open = null;
    return { changed: true };
  }

  private predictAnswer(open: Extract<OpenQuestion, { kind: 'predict' }>, a: AnswerInput): AnswerResult {
    const evaluation = evaluatePrediction(open.prediction, a.text);
    this.policy?.finishQuestion(open.questionId, a.atMs);
    this.open = null;
    if (this.teach) this.teach.verdict = evaluation.verdict;
    const quote = evaluation.quotes[0];
    const text = quote ? `${evaluation.feedback} The expert said: "${quote.replace(/[.!?]+$/, '')}."` : evaluation.feedback;
    this.outbox.push({
      decision: 'PREDICT', topic: 'predict_feedback', kind: 'feedback', whyNow: `The new hire's prediction was a ${evaluation.verdict}.`,
      evidenceIds: [...open.prediction.evidenceIds], utterance: { text }, expectsAnswer: false,
      clipa: { state: 'speaking' },
    });
    return { changed: true };
  }

  /** The teach-back the reply is for: the one the person has on screen (its digest), else the one that was spoken. */
  private heardFor(a: AnswerInput): TeachBack | undefined {
    if (a.digest) return { text: '', evidenceIds: [], version: 0, digest: a.digest };
    return this.heard ?? undefined;
  }

  private teachBackId(): string {
    return `teachback:${workingMap(this.state).version}`;
  }

  /**
   * The reply to the teach-back, by voice (verdict from the classifier) or typed (verdict forced). The gate lives in packages/agent:
   * a reply counts for the teach-back it followed (its digest), a confirmation is only confirmation words, two unclear replies in a
   * row hand over to the buttons, and a reply to a teach-back that is out of date confirms nothing (`stale`).
   */
  private async reply(a: AnswerInput, force: 'correct' | null): Promise<AnswerResult> {
    const forced: ReplyClassifier | null = force === 'correct'
      ? { name: 'typed correction', classify: (): Promise<ReplyVerdict> => Promise.resolve({ verdict: 'correct', correction: null }) }
      : null;
    this.busy = true;
    try {
      const id = this.teachBackId();
      const outcome = await applyTeachBackReply(this.state, { text: a.text, atMs: a.atMs }, this.extractor, forced ?? this.classifier, this.heardFor(a));
      this.state = outcome.state;
      this.open = null;
      this.policy?.setMap(workingMap(this.state));
      switch (outcome.outcome) {
        case 'refused': {
          this.reviewHalted = true;
          const missing = outcome.issues.map((i) => `${i.kind} ${i.id} lacks ${i.missing.join(' and ')}`).join('; ');
          this.options.log(`Teach-back not confirmed: ${missing}.`);
          this.say('refused', `I cannot save this version yet: ${missing}. Please answer the open questions first.`);
          break;
        }
        case 'unclear': {
          const step = this.clarifier.unclear(id);
          if (step.kind === 'buttons') {
            this.buttons = true;
            this.options.log('Teach-back reply unclear twice: Confirm, Correct and Skip are offered; the rule stays provisional.');
            this.say('unclear', 'I could not tell whether that was a yes or a correction. Please use the buttons: Confirm, Correct or Skip. Until then I will not treat the rule as confirmed.');
          } else {
            this.options.log(`Teach-back reply unclear (ask again, attempt ${step.attempt}).`);
          }
          break;
        }
        case 'stale':
          this.heard = outcome.teachBack;
          this.options.log('The teach-back changed since it was heard: nothing was confirmed; the current version is played back again.');
          break;
        case 'confirmed':
          this.clarifier.understood(id);
          this.heard = null;
          this.buttons = false;
          this.options.log(`Work Map version ${latestConfirmed(this.state)?.version ?? '?'} confirmed.`);
          break;
        case 'corrected':
          this.clarifier.understood(id);
          this.heard = null;
          this.buttons = false;
          this.options.log(`Work Map corrected: provisional version ${workingMap(this.state).version}, to be confirmed by a new teach-back.`);
          break;
      }
      return { teachBack: outcome.outcome, changed: true };
    } finally {
      this.busy = false;
      this.lastAnsweredAtMs = this.nowMs;
    }
  }

  /** Confirm and Skip buttons: Confirm carries the digest of the teach-back on screen (pressReviewButton refuses a stale one). */
  private pressButton(a: AnswerInput, button: 'confirm' | 'skip'): AnswerResult {
    const id = this.teachBackId();
    const out = pressReviewButton(this.state, this.clarifier, id, button, a.atMs, this.heardFor(a));
    this.state = out.state;
    switch (out.outcome) {
      case 'confirmed':
        this.open = null;
        this.heard = null;
        this.buttons = false;
        this.policy?.setMap(workingMap(this.state));
        this.options.log(`Work Map version ${latestConfirmed(this.state)?.version ?? '?'} confirmed with the button.`);
        return { teachBack: 'confirmed', changed: true };
      case 'stale':
        this.heard = out.teachBack;
        this.options.log('Confirm refused: the teach-back on screen is out of date (the map changed). Nothing was confirmed.');
        return { teachBack: 'stale', changed: true };
      case 'skipped':
        this.open = null;
        this.buttons = false;
        this.reviewHalted = true;
        this.options.log('Teach-back skipped: the rule stays provisional, so Teach will not apply it.');
        this.say('skipped', 'Skipped. The rule stays unconfirmed, so in Teach I will say I do not know instead of applying it.');
        return { teachBack: 'skipped', changed: true };
      case 'refused':
        this.options.log(`Confirm refused: ${out.issues.map((i) => `${i.kind} ${i.id} lacks ${i.missing.join(' and ')}`).join('; ')}.`);
        return { teachBack: 'refused' };
      case 'needs_words':
        return { teachBack: 'needs_words' };
    }
  }

  // ---- Review: the debrief ------------------------------------------------

  private say(topic: string, text: string): void {
    this.outbox.push({
      decision: 'ASK_NOW', topic, kind: TOPIC_KIND[topic] ?? topic, whyNow: 'The debrief says something that needs no answer.', evidenceIds: [],
      utterance: { text }, expectsAnswer: false, clipa: { state: 'speaking' },
    });
  }

  private reviewTick(nowMs: number, signals: BrainSignals | undefined): BrainDecision[] {
    if (this.busy || this.open !== null || this.reviewHalted) return [];
    if (!signals || !signals.voiceConnected || signals.agentSpeaking || signals.humanSpeaking) return [];
    if (this.lastAnsweredAtMs !== null && nowMs - this.lastAnsweredAtMs < REVIEW_GAP_MS) return [];
    if (nowMs < this.holdUntilMs) return [];

    const map = workingMap(this.state);
    const held = this.learnPolicy?.heldForReview(nowMs) ?? [];
    const next = planFollowUps(map, { persona: this.persona, held, max: MAX_FOLLOW_UPS }).find((q) => !this.asked.has(keyOf(q)));
    if (next !== undefined) {
      this.asked.add(keyOf(next));
      const questionId = `rv-${++this.reviewSeq}`;
      this.open = { kind: 'followup', questionId, question: next };
      return [{
        decision: 'ASK_NOW', questionId, topic: next.topic, kind: TOPIC_KIND[next.topic] ?? next.topic, evidenceIds: [...next.evidenceIds],
        whyNow: `The Work Map has a gap about ${next.topic.replace(/_/g, ' ')} that the task did not close.`,
        utterance: { text: next.text }, expectsAnswer: true, clipa: { state: 'speaking' },
      }];
    }
    const status = reviewStatus(this.state, { persona: this.persona, held, unresolved: this.clarifier.unresolved() });
    if (status.done) {
      if (this.reviewClosed) return [];
      this.reviewClosed = true;
      this.say('review_done', `Thank you. The Work Map is confirmed (version ${status.confirmed?.version ?? map.version}). You can switch to Teach now.`);
      return this.outbox.splice(0);
    }
    // After two unclear replies the buttons take over: nothing is asked again until one is pressed.
    if (map.guardrails.length === 0 && !this.buttons) {
      // Nothing to play back: say the next step once instead of going quiet.
      if (!this.emptyNoted) {
        this.emptyNoted = true;
        return [{
          decision: 'ASK_NOW', topic: 'review_empty', kind: 'review_empty', evidenceIds: [], expectsAnswer: false, clipa: { state: 'speaking' },
          whyNow: 'The Work Map holds no rule yet, so there is no teach-back to confirm.',
          utterance: { text: 'The map does not hold a rule yet, so I have nothing to play back. Run Learn first: do the task and answer a few questions. Then come back to Review.' },
        }];
      }
      return [];
    }
    if (this.buttons) return [];
    // Planned here, stated in onSpoken (when it reaches the voice): a confirmation counts only for what the expert was told.
    const tb = stateTeachBack(this.state).teachBack;
    const questionId = `rv-${++this.reviewSeq}`;
    this.open = { kind: 'teachback', questionId, heard: tb };
    return [{
      decision: 'ASK_NOW', questionId, topic: 'teach_back', kind: 'teach_back', evidenceIds: [...tb.evidenceIds],
      whyNow: `No gap is left; playing back version ${map.version} for the expert to confirm or correct.`,
      utterance: { text: tb.text }, expectsAnswer: true, clipa: { state: 'speaking' },
    }];
  }

  // ---- Review and the map, for the screen ---------------------------------

  /**
   * `shown`: the teach-back text is on the person's screen (the Review view), so it counts as stated, exactly like a spoken one. A
   * reload for the Learn view or the draft map (shown = false) never states anything: nobody read it.
   */
  review(shown = false): ReviewOutput {
    const map = workingMap(this.state);
    const held = this.learnPolicy?.heldForReview(this.nowMs) ?? [];
    const gaps = planFollowUps(map, { persona: this.persona, held, max: MAX_FOLLOW_UPS, unresolved: this.clarifier.unresolved() }).map((q) => ({
      id: q.id, topic: q.topic, question: q.text, evidenceIds: [...q.evidenceIds],
    }));
    let tb: TeachBack | null = null;
    if (gaps.length === 0 && map.guardrails.length > 0) {
      const stated = stateTeachBack(this.state);
      tb = stated.teachBack;
      if (shown) {
        this.state = stated.state;
        this.heard = tb;
      }
    }
    return { gaps, teachBack: tb?.text ?? null, teachBackDigest: tb?.digest ?? null, buttons: this.buttons, map: this.shown(workingMap(this.state)) };
  }

  private shown(map: WorkMap): DraftMap {
    const confirmed = latestConfirmed(this.state);
    return toDraftMap(map, confirmed !== null && confirmed.version === map.version && !this.state.draft.dirty, this.mapSynthetic);
  }

  // ---- Teach --------------------------------------------------------------

  checkpoint(c: ActionCheckpoint): CheckpointReply {
    const map = latestConfirmed(this.state);
    const verdict = judgeCheckpoint({ checkpoint: c, observations: this.observations, map, sessionId: this.sessionId });
    const reply: CheckpointReply = {
      schemaVersion: 1, checkpointId: verdict.checkpointId, status: verdict.status, message: verdict.message,
      evidenceIds: [...verdict.evidenceIds], basedOn: { order: verdict.basedOn.order, email: verdict.basedOn.email },
    };
    this.options.log(`checkpoint ${c.id}: ${verdict.status}${map ? ` against Work Map version ${map.version}` : ' (no confirmed map)'}.`);
    const policy = this.policy;
    if (policy) {
      const d = policy.decideCheckpoint({ status: verdict.status, evidenceIds: verdict.evidenceIds }, this.nowMs);
      if (d.decision === 'WARN') {
        this.outbox.push({
          decision: 'WARN', topic: 'checkpoint', kind: verdict.status === 'warn' ? 'guardrail' : 'unknown', whyNow: d.whyNow,
          evidenceIds: [...verdict.evidenceIds], utterance: { text: verdict.message }, expectsAnswer: false,
          clipa: { state: 'warning', target: SEND_TARGET },
        });
      }
    }
    const t = this.teach;
    if (t !== null && t.firstStatus === null) {
      t.firstStatus = verdict.status;
      // A case is judged only when the tutor really judged it: a confirmed map, a checkpoint that is not `unknown`, and, where the
      // tutor asked the new hire to predict, an answer. Anything else is "not judged": never mastered, never practise.
      const unanswered = t.prediction !== null && t.verdict === null;
      const why = map === null ? 'there is no confirmed Work Map' : verdict.status === 'unknown' ? 'the tutor could not tell what is right (unknown)' : unanswered ? 'the prediction was not answered' : null;
      this.outcomes = this.outcomes.filter((o) => o.caseId !== t.caseId);
      this.notJudged = this.notJudged.filter((n) => n.caseId !== t.caseId);
      if (why !== null) this.notJudged.push({ caseId: t.caseId, title: t.title, why });
      else this.outcomes.push({ caseId: t.caseId, title: t.title, verdict: t.verdict ?? 'match', firstStatus: verdict.status, sent: false });
    }
    return reply;
  }

  /** What has been mastered over the Teach cases so far. */
  mastery(): MasteryLines | null {
    if (this.outcomes.length === 0 && this.notJudged.length === 0) return null;
    const m = summarizeMastery(this.outcomes);
    const lineOf = (id: string): string => m.lines[this.outcomes.findIndex((o) => o.caseId === id)] ?? id;
    return {
      mastered: m.mastered.map(lineOf),
      practise: m.practise.map(lineOf),
      notJudged: this.notJudged.map((n) => `${n.caseId.toUpperCase()} ${n.title}: not judged (${n.why})`),
    };
  }

  /** The Work Map version Teach would use, for the UI and the log. */
  confirmedVersion(): number | null {
    return latestConfirmed(this.state)?.version ?? null;
  }

  /** Prediction of the map for an order, as the tutor would ask it (exposed for tests and the debug view). */
  predictionFor(order: Parameters<typeof buildPrediction>[0]): Prediction {
    return buildPrediction(order, latestConfirmed(this.state));
  }
}

// ---- WorkMap -> the shell's DraftMap ---------------------------------------------------------------------------------

function guardrailText(g: WorkMap['guardrails'][number]): string {
  const who = g.scope.kind === 'all' ? 'every customer' : g.scope.customers.join(', ') || 'this customer';
  const rule = g.trigger === 'customer'
    ? `${who}: ${g.requiredAction}`
    : g.trigger === 'unknown_entity'
      ? `If the customer is not recognised: ${g.requiredAction}`
      : `${g.condition}: ${g.requiredAction}`;
  const assumed = g.assumedFacts.length > 0 ? ` (I assume the ${labelFacts(g.assumedFacts)} from the screen.)` : '';
  const why = g.reason !== null ? ` Reason: ${g.reason}.` : g.unexplained || g.reasonUnknown ? ' The expert does not know the reason.' : '';
  const quote = g.quote !== null ? ` The expert: "${g.quote}"` : '';
  return `${rule}${assumed}${why}${quote}`;
}

export function toDraftMap(map: WorkMap, confirmed: boolean, synthetic = false): DraftMap {
  const guardrails: GuardrailRef[] = map.guardrails.map((g) => ({ id: g.id, text: guardrailText(g), evidenceIds: [...g.evidenceIds] }));
  const byId = new Map(guardrails.map((g) => [g.id, g]));
  const steps: DraftStep[] = map.steps.map((s) => {
    const evidence = [...new Set([...s.evidenceIds, ...(s.decision?.evidenceIds ?? [])])];
    return {
      id: s.id,
      title: s.goal || s.action,
      kind: s.kind === 'judgment' ? 'judgment' : 'step',
      decision: s.decision?.summary ?? null,
      reason: s.decision?.reason ?? s.decision?.quote ?? null,
      guardrails: s.guardrailIds.flatMap((id) => { const g = byId.get(id); return g ? [g] : []; }),
      evidenceIds: evidence,
      atMs: s.atMs,
      ...(synthetic ? { synthetic: true } : {}),
    };
  });
  return { steps, version: map.version, confirmed, guardrails, ...(synthetic ? { synthetic: true } : {}) };
}
