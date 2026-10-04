// Reads the scripted actors of fixtures/agent/sim (the expert and the new hire). Tests only: the shell code never reads them.
import { readFileSync } from 'node:fs';

const root = new URL('../../../../../../fixtures/agent/', import.meta.url);

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(rel, root), 'utf8')) as Record<string, unknown>;
}
const rec = (u: unknown): Record<string, unknown> => u as Record<string, unknown>;

export function expertAnswer(topic: string): string {
  return String(rec(rec(readJson('sim/expert-script.json')['answers'])[topic])['text']);
}

export function expertTeachback(kind: 'correction' | 'confirm'): string {
  return String(rec(rec(readJson('sim/expert-script.json')['teachback'])[kind])['text']);
}

export function novicePredict(caseId: string): string {
  const cases = readJson('sim/novice-script.json')['cases'] as Array<Record<string, unknown>>;
  const found = cases.find((c) => c['case'] === caseId);
  return String(rec(found?.['predict'])['text']);
}

/** fixtures/agent/llm/recorded.json: the route's outputs for the scripted answers, keyed by task. */
export function recordedLlm(): Record<string, Array<Record<string, unknown>>> {
  return readJson('llm/recorded.json') as Record<string, Array<Record<string, unknown>>>;
}

export function learnFixture(): { observations: Array<Record<string, unknown>> } {
  return readJson('learn-customer07.json') as { observations: Array<Record<string, unknown>> };
}
