// "Natural pause" = all four channels quiet at the same time, each for the persona's threshold:
//   input   no input event in the workspace (typing heartbeat, lastInputAtMs)
//   screen  no significant change on screen (facts differ from the previous observation of the same kind)
//   human   not speaking, and the last phrase ended long enough ago
//   agent   Clipa is not speaking (immediately quiet)
// Pure bookkeeping: time is always passed in, nothing is scheduled.
import type { ScreenObservation } from "@apprentice/contracts";
import { factsFingerprint } from "../knowledge/facts.ts";
import type { PolicyReason, QuietSnapshot, QuietThresholds } from "./types.ts";

export class QuietTracker {
  private lastInputAtMs: number | null = null;
  private lastChangeAtMs: number | null = null;
  private humanSpeaking = false;
  private humanEndedAtMs: number | null = null;
  private agentSpeaking = false;
  private offRecord = false;
  private readonly lastFacts = new Map<string, string>();

  /** Feed every observation, in order. Input heartbeats move the typing channel; other kinds move the screen channel if they changed. */
  observe(obs: ScreenObservation): void {
    if (obs.kind === "input_activity") {
      this.lastInputAtMs = Math.max(this.lastInputAtMs ?? 0, obs.facts.lastInputAtMs);
      return;
    }
    // Noise (OCR whitespace, case, punctuation, attachment text) is not a change on screen.
    const facts = factsFingerprint(obs.facts);
    if (this.lastFacts.get(obs.kind) === facts) return;
    this.lastFacts.set(obs.kind, facts);
    this.lastChangeAtMs = Math.max(this.lastChangeAtMs ?? 0, obs.timestampMs);
  }

  setHumanSpeaking(speaking: boolean, atMs: number): void {
    if (this.humanSpeaking && !speaking) this.humanEndedAtMs = atMs;
    this.humanSpeaking = speaking;
  }

  setAgentSpeaking(speaking: boolean): void {
    this.agentSpeaking = speaking;
  }

  setOffRecord(on: boolean): void {
    this.offRecord = on;
  }

  isOffRecord(): boolean {
    return this.offRecord;
  }

  snapshot(now: number, th: QuietThresholds): QuietSnapshot {
    const since = (t: number | null): number | null => (t === null ? null : Math.max(0, now - t));
    const inputIdleMs = since(this.lastInputAtMs);
    const screenStableMs = since(this.lastChangeAtMs);
    const humanQuietForMs = this.humanSpeaking ? 0 : since(this.humanEndedAtMs);
    const channels = {
      input: inputIdleMs === null || inputIdleMs >= th.inputPauseMs,
      screen: screenStableMs === null || screenStableMs >= th.screenStableMs,
      human: !this.humanSpeaking && (humanQuietForMs === null || humanQuietForMs >= th.humanQuietMs),
      agent: !this.agentSpeaking,
    };
    return {
      atMs: now,
      inputIdleMs,
      screenStableMs,
      humanSpeaking: this.humanSpeaking,
      humanQuietForMs,
      agentSpeaking: this.agentSpeaking,
      offRecord: this.offRecord,
      thresholds: { ...th },
      channels,
      natural: !this.offRecord && channels.input && channels.screen && channels.human && channels.agent,
    };
  }
}

/** The channels that are not quiet, as policy reasons. */
export function quietBlockers(q: QuietSnapshot): PolicyReason[] {
  const out: PolicyReason[] = [];
  if (q.offRecord) out.push("off_record");
  if (!q.channels.input) out.push("typing");
  if (!q.channels.human) out.push("human_speaking");
  if (!q.channels.agent) out.push("agent_speaking");
  if (!q.channels.screen) out.push("screen_not_stable");
  return out;
}
