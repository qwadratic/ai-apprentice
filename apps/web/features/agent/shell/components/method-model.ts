// The method panel's model ("How Clipa thinks"): what each of the five boxes says, the newest live item for it (or a short
// example, marked as one) and the small knowledge graph of the Work Map. Pure: no React, no clock, tested with node --test.
import type { DraftMap } from '../brain/types.ts';
import type { ConductorMapSnapshot, SaidItem } from '../conductor/store.ts';
import type { CheckpointCard, FeedItem, LogLine, ObservationRow } from '../state/types.ts';

export const BOX_IDS = ['signals', 'events', 'reasoning', 'knowledge', 'teaching'] as const;
export type BoxId = (typeof BOX_IDS)[number];

/** The five boxes, left to right: what each one is. The live item and the example are in methodBoxes. */
export const METHOD: Readonly<Record<BoxId, { title: string; what: string; example: string }>> = {
  signals: {
    title: 'Raw signals',
    what: 'Screen frames, the pointer and speech. Raw data: nothing is decided here.',
    example: 'Frame at 00:41, the pointer on Preview, the expert saying “her phone blocks images”.',
  },
  events: {
    title: 'Events',
    what: 'What changed on screen, in words.',
    example: 'The delivery address and window were typed into the email body.',
  },
  reasoning: {
    title: 'Reasoning',
    what: 'When to speak: at a pause. What to ask: the why behind the change.',
    example: 'Why the address as text, and not the image?',
  },
  knowledge: {
    title: 'Knowledge graph',
    what: 'Process, step, decision, rule, exception. Each is linked to its evidence: the screen moment and the expert’s words.',
    example: '1 process, 1 rule, 1 exception, each with its evidence.',
  },
  teaching: {
    title: 'Teaching',
    what: 'The new hire is checked against the confirmed rules before Send.',
    example: 'Stop before Send: this customer needs the address and window as text.',
  },
};

export interface MethodBox {
  id: BoxId;
  /** 1-based position, left to right. */
  step: number;
  title: string;
  what: string;
  /** The newest live item, or null. */
  live: string | null;
  /** Shown (and marked "example") while `live` is null. */
  example: string;
  /** The live item comes from the sample source (invented data, not the person's screen). */
  synthetic: boolean;
}

/** The part of a Work Map the panel shows: its rules with the expert's words and exceptions. */
export interface MapSummary {
  process: string | null;
  steps: number;
  rules: Array<{ id: string; text: string; quote: string | null; exceptions: string[] }>;
}

export interface MethodInput {
  observations: readonly ObservationRow[];
  /** The debug log: its USER lines are the person's own words (already scrubbed). */
  events: readonly LogLine[];
  /** The in-browser brain's questions (the fallback when the conductor does not lead). */
  feed: readonly FeedItem[];
  /** What the conductor had Clipa ask, warn or say. */
  said: readonly SaidItem[];
  checkpoint: CheckpointCard | null;
  summary: MapSummary | null;
  /** true: the conductor leads, so the questions come from `said`; false: from the brain's `feed`. */
  conductorLeads: boolean;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** One line, at most `max` characters. */
export function clip(s: string, max = 140): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The conductor's generic map as a summary; null when there is no map or it is empty. Read defensively. */
export function summarizeGenericMap(snapshot: ConductorMapSnapshot | null): MapSummary | null {
  if (snapshot === null || !isRec(snapshot.map)) return null;
  const raw = snapshot.map;
  const steps = list(raw.steps).filter(isRec).length;
  const rules = list(raw.guardrails).filter(isRec).map((g, i) => {
    const condition = text(g.condition);
    const action = text(g.requiredAction);
    return {
      id: text(g.id, 64) ?? `g${i + 1}`,
      text: condition !== null && action !== null ? `${condition}: ${action}` : (condition ?? action ?? 'A new rule'),
      quote: text(g.quote, 400),
      exceptions: list(g.exceptions).map((e) => text(e, 200)).filter((e): e is string => e !== null),
    };
  });
  if (steps === 0 && rules.length === 0) return null;
  const firstProcess = list(raw.processes).filter(isRec).map((p) => text(p.title, 120)).find((t): t is string => t !== null) ?? null;
  return { process: firstProcess, steps, rules };
}

/** The in-browser brain's draft map as a summary: a step's reason is the expert's words for the rules of that step. */
export function summarizeDraftMap(map: DraftMap): MapSummary | null {
  const seen = new Set<string>();
  const rules: MapSummary['rules'] = [];
  for (const step of map.steps) {
    for (const g of step.guardrails) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      rules.push({ id: g.id, text: g.text, quote: step.reason, exceptions: [] });
    }
  }
  for (const g of map.guardrails ?? []) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    rules.push({ id: g.id, text: g.text, quote: null, exceptions: [] });
  }
  if (map.steps.length === 0 && rules.length === 0) return null;
  return { process: null, steps: map.steps.length, rules };
}

/** The counts line of the knowledge box. */
export function mapCounts(summary: MapSummary): string {
  const exceptions = summary.rules.reduce((n, r) => n + r.exceptions.length, 0);
  return `${plural(summary.steps, 'step')}, ${plural(summary.rules.length, 'rule')}, ${plural(exceptions, 'exception')}`;
}

/** The newest question Clipa asked: from the conductor's lines while it leads, else from the in-browser brain's feed. */
export function lastQuestion(input: Pick<MethodInput, 'said' | 'feed' | 'conductorLeads'>): string | null {
  if (input.conductorLeads) {
    for (let i = input.said.length - 1; i >= 0; i -= 1) {
      const s = input.said[i]!;
      if (s.kind === 'ask' && s.outcome !== 'skipped' && s.text.trim() !== '') return s.text.trim();
    }
    return null;
  }
  for (let i = input.feed.length - 1; i >= 0; i -= 1) {
    const f = input.feed[i]!;
    if ((f.status === 'asked' || f.status === 'answered') && f.text.trim() !== '') return f.text.trim();
  }
  return null;
}

/** The newest thing the person said, from the transcript lines of the debug log. */
export function lastSpeech(events: readonly LogLine[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === 'USER' && e.text.trim() !== '') return e.text.trim();
  }
  return null;
}

/** The newest screen observation that says something (typing on or off is not a change). */
export function lastObservation(observations: readonly ObservationRow[]): ObservationRow | null {
  for (let i = observations.length - 1; i >= 0; i -= 1) {
    const o = observations[i]!;
    if (o.kind !== 'input_activity' && o.summary.trim() !== '') return o;
  }
  return null;
}

const CHECK_WORDS = { warn: 'Stop before Send', clear: 'Clear to send', unknown: 'Not sure' } as const;

/** The newest tutor check, as one line. */
export function checkLine(card: CheckpointCard | null): string | null {
  if (card === null) return null;
  return `${CHECK_WORDS[card.status]}: ${card.message.trim()}`;
}

/** The five boxes with the newest live item each, where the stores have one. */
export function methodBoxes(input: MethodInput): MethodBox[] {
  const speech = lastSpeech(input.events);
  const observation = lastObservation(input.observations);
  const question = lastQuestion(input);
  const live: Record<BoxId, string | null> = {
    signals: speech === null ? null : `“${clip(speech, 120)}”`,
    events: observation === null ? null : clip(observation.summary, 140),
    reasoning: question === null ? null : clip(question, 140),
    knowledge: input.summary === null ? null : mapCounts(input.summary),
    teaching: ((line) => (line === null ? null : clip(line, 160)))(checkLine(input.checkpoint)),
  };
  return BOX_IDS.map((id, i): MethodBox => ({
    id,
    step: i + 1,
    title: METHOD[id].title,
    what: METHOD[id].what,
    live: live[id],
    example: METHOD[id].example,
    synthetic: id === 'events' && live.events !== null && observation?.synthetic === true,
  }));
}

// ---- the knowledge graph ------------------------------------------------------------------------------------------------
// A small tree in a narrow box, so it stays legible on a phone: the process on top, then each rule (at most three) with the
// exception beside the expert's words under it. At most 1 + 3 x 3 = 10 nodes. The example is the customer_07 rule.

export interface GraphNode {
  id: string;
  kind: 'process' | 'rule' | 'exception' | 'evidence';
  /** The small label on the node ("Rule"). */
  tag: string;
  lines: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphEdge {
  id: string;
  /** owns: process to rule; except: rule to its exception; said: the expert's words support the rule. */
  kind: 'owns' | 'except' | 'said';
  d: string;
}

export interface KnowledgeGraph {
  width: number;
  height: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The graph is the customer_07 example, not the current Work Map. */
  example: boolean;
}

export const EXAMPLE_SUMMARY: MapSummary = {
  process: 'Send a delivery update',
  steps: 5,
  rules: [{
    id: 'example-rule',
    text: 'Write the address and window in the email',
    quote: 'Their phone blocks images.',
    exceptions: ['An image is fine when the details are also in text'],
  }],
};

export const GRAPH_MAX_RULES = 3;
const WIDTH = 340;
const MARGIN = 10;
const GAP = 18;
const LINE = 14;
const HEAD = 22;
const FOOT = 8;
/** About how many characters of the 11.5 px label font fit in a node of this width. */
const charsFor = (w: number): number => Math.max(8, Math.floor((w - 16) / 6.1));
const heightFor = (lines: number): number => HEAD + lines * LINE + FOOT;

/** Greedy word wrap into at most `maxLines` lines; what does not fit ends in an ellipsis. */
export function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const raw of value.trim().split(/\s+/).filter(Boolean)) {
    const word = raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}…` : raw;
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= maxChars) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  kept[maxLines - 1] = last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
  return kept;
}

/**
 * The graph of a map summary: null (or a summary without a rule) gives the example, marked `example`. Rules beyond the third and
 * all but the first exception of a rule are left out; the counts in the knowledge box still count everything.
 */
export function buildGraph(summary: MapSummary | null): KnowledgeGraph {
  const real = summary !== null && summary.rules.length > 0;
  const source = real ? summary : EXAMPLE_SUMMARY;
  const full = WIDTH - 2 * MARGIN;
  const half = (full - 10) / 2;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const processLines = wrapText(source.process ?? 'The expert’s process', charsFor(full), 1);
  const process: GraphNode = { id: 'process', kind: 'process', tag: 'PROCESS', lines: processLines, x: MARGIN, y: 0, w: full, h: heightFor(processLines.length) };
  nodes.push(process);
  let y = process.h + GAP;

  source.rules.slice(0, GRAPH_MAX_RULES).forEach((rule, i) => {
    const ruleLines = wrapText(rule.text, charsFor(full), 2);
    const node: GraphNode = { id: `rule-${i}`, kind: 'rule', tag: 'RULE', lines: ruleLines, x: MARGIN, y, w: full, h: heightFor(ruleLines.length) };
    nodes.push(node);
    edges.push({ id: `owns-${i}`, kind: 'owns', d: `M ${MARGIN} ${process.y + process.h / 2} H 3 V ${node.y + node.h / 2} H ${MARGIN}` });
    y += node.h;

    const exception = rule.exceptions[0] ?? null;
    const quote = rule.quote;
    if (exception !== null || quote !== null) {
      y += GAP;
      const exLines = exception === null ? [] : wrapText(exception, charsFor(half), 3);
      const quLines = quote === null ? [] : wrapText(`“${quote}”`, charsFor(half), 3);
      const rowH = heightFor(Math.max(exLines.length, quLines.length));
      if (exception !== null) {
        const ex: GraphNode = { id: `exception-${i}`, kind: 'exception', tag: 'EXCEPTION', lines: exLines, x: MARGIN, y, w: half, h: rowH };
        nodes.push(ex);
        edges.push({ id: `except-${i}`, kind: 'except', d: `M ${ex.x + ex.w / 2} ${node.y + node.h} V ${ex.y}` });
      }
      if (quote !== null) {
        const ev: GraphNode = { id: `evidence-${i}`, kind: 'evidence', tag: 'EXPERT SAID', lines: quLines, x: MARGIN + half + 10, y, w: half, h: rowH };
        nodes.push(ev);
        edges.push({ id: `said-${i}`, kind: 'said', d: `M ${ev.x + ev.w / 2} ${ev.y} V ${node.y + node.h}` });
      }
      y += rowH;
    }
    y += GAP;
  });

  return { width: WIDTH, height: y - GAP + 2, nodes, edges, example: !real };
}

/** The graph in words, for screen readers. */
export function describeGraph(graph: KnowledgeGraph): string {
  const parts = graph.nodes.map((n) => `${n.tag.toLowerCase()}: ${n.lines.join(' ')}`);
  return `${graph.example ? 'Example knowledge graph. ' : 'Knowledge graph of the Work Map. '}${parts.join('; ')}.`;
}
