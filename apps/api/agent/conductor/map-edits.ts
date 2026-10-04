// Applies the checked operations of map_edit to the map. Pure: the expert talks, Clipa edits, the result is a new map.
import type { EditOperation, MapSynthesisOutput } from '../llm-tasks.ts';

export interface MapComment { targetId: string; text: string; atMs: number }
export type ConductorMap = MapSynthesisOutput & { comments: MapComment[] };

const nextId = (prefix: string, ids: readonly string[]): string => {
  const max = ids.reduce((m, id) => { const n = Number(id.slice(prefix.length)); return id.startsWith(prefix) && Number.isInteger(n) ? Math.max(m, n) : m; }, 0);
  return `${prefix}${max + 1}`;
};

/**
 * A reason added by voice stays tied to the expert's words: the quote the model found in the utterance, else the
 * utterance itself (capped). Returns the new map and how many operations changed something.
 */
export function applyEdits(map: ConductorMap, ops: readonly EditOperation[], utterance: string, atMs: number): { map: ConductorMap; applied: number } {
  const next: ConductorMap = structuredClone(map);
  const words = (quote: string | null): string => quote ?? utterance.slice(0, 300);
  const resolved = new Set<number>();
  let applied = 0;
  for (const op of ops) {
    const step = op.targetId ? next.steps.find((s) => s.id === op.targetId) : undefined;
    const rule = op.targetId ? next.guardrails.find((g) => g.id === op.targetId) : undefined;
    switch (op.op) {
      case 'set': {
        if (!op.value) break;
        if (step) {
          if (op.field === 'goal') step.goal = op.value;
          else if (op.field === 'action') step.action = op.value;
          else if (op.field === 'decision') {
            step.kind = 'judgment';
            step.decision = step.decision ? { ...step.decision, summary: op.value } : { summary: op.value, reason: null, quote: null, quoteAtMs: null };
          } else if (op.field === 'reason') {
            step.kind = 'judgment';
            const base = step.decision ?? { summary: step.goal, reason: null, quote: null, quoteAtMs: null };
            step.decision = { ...base, reason: op.value, quote: words(op.quote), quoteAtMs: atMs };
          } else break;
          applied++;
        } else if (rule) {
          if (op.field === 'condition') rule.condition = op.value;
          else if (op.field === 'requiredAction') rule.requiredAction = op.value;
          else if (op.field === 'escalateTo') rule.escalateTo = op.value;
          else if (op.field === 'exception') rule.exceptions = [...rule.exceptions, op.value].slice(-5);
          else if (op.field === 'reason') { rule.reason = op.value; rule.quote = words(op.quote); rule.quoteAtMs = atMs; }
          else break;
          applied++;
        }
        break;
      }
      case 'add_step': {
        if (!op.value) break;
        const id = nextId('s', next.steps.map((s) => s.id));
        const at = op.targetId ? next.steps.findIndex((s) => s.id === op.targetId) + 1 : next.steps.length;
        const neighbour = op.targetId ? next.steps.find((s) => s.id === op.targetId) : next.steps[next.steps.length - 1];
        next.steps.splice(at > 0 ? at : next.steps.length, 0, { id, processId: neighbour?.processId ?? null, kind: 'action', goal: op.value2 ?? op.value, action: op.value, decision: null, evidenceIds: [] });
        applied++;
        break;
      }
      case 'add_rule': {
        if (!op.value || !op.value2) break;
        const id = nextId('g', next.guardrails.map((g) => g.id));
        next.guardrails.push({ id, processId: next.processes?.length === 1 ? next.processes[0]!.id : null, condition: op.value, requiredAction: op.value2, reason: null, quote: words(op.quote), quoteAtMs: atMs, escalateTo: null, exceptions: [], evidenceIds: [] });
        applied++;
        break;
      }
      case 'remove': {
        if (step) next.steps = next.steps.filter((s) => s !== step);
        else if (rule) next.guardrails = next.guardrails.filter((g) => g !== rule);
        else break;
        next.gaps = next.gaps.map((g) => (g.targetId === op.targetId ? { ...g, targetId: null } : g));
        applied++;
        break;
      }
      case 'comment': {
        if (!op.value || !op.targetId || (!step && !rule)) break;
        next.comments = [...next.comments, { targetId: op.targetId, text: op.value, atMs }].slice(-50);
        applied++;
        break;
      }
      case 'resolve_gap': {
        const n = Number((op.targetId ?? '').replace(/^gap-/, ''));
        if (Number.isInteger(n) && n >= 1 && n <= next.gaps.length) { resolved.add(n - 1); applied++; }
        break;
      }
    }
  }
  if (resolved.size) next.gaps = next.gaps.filter((_, i) => !resolved.has(i));
  return { map: next, applied };
}
