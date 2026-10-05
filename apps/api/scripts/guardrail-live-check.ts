// Opt-in regression: T1-T6 against the LIVE `guardrail_check` LLM task, through the real Claude runner.
//
// `npm test` already runs a T1-T6 regression (packages/agent/test/gate.test.ts), but that one drives the
// deterministic, heuristic engine in packages/agent/src: no network, no model, no cost, always the same answer.
// This script is the other half: it sends the same six cases to the actual runner apps/api talks to in
// production, through the exact same code apps/api uses (LLM_TASKS.guardrail_check.prepare/check from
// ../agent/llm-tasks.ts, callRunner from ../agent/llm.ts, via runLlmTask), and checks whether a real model still
// agrees with the expected outcome. It is a model/prompt sanity check, not a correctness proof of the API code.
//
// Never run automatically and never part of `npm test`: it costs a real model call per case and needs a live
// runner. Opt in by running it yourself, or via workflow_dispatch (.github/workflows/guardrail-live.yml), which
// supplies RUNNER_URL and RUNNER_TOKEN from repository secrets and skips cleanly when they are not configured.
//
// Run: RUNNER_URL=https://runner.example RUNNER_TOKEN=... node apps/api/scripts/guardrail-live-check.ts
//
// Inputs: fixtures/agent/teach/t1..t6.json (the screen each case shows: which customer, the email draft, whether
// the template screenshot is attached) and fixtures/agent/sim/scenario.json (which customer each order belongs
// to) -- the same fixtures packages/agent/test/brain-helpers.ts reads for the deterministic suite. The guardrail
// itself (condition, requiredAction, reason, quote) is assembled from fixtures/agent/sim/expert-script.json's
// "reason" and "scope" answers, matching the confirmed rule the deterministic suite's "full flow" test ends on
// (packages/agent/test/gate.test.ts): the corrected version that requires the order number as well as the
// address and delivery window (see expert-script.json's teachback.correction).
//
// Expected outcomes: fixtures/agent/expected/t1..t6.json. Only `status` (clear/warn/unknown) is a like-for-like
// comparison: guardrail_check's output shape is {status, guardrailId, message, regionIds}, while the other
// fields in the expected fixtures (policy, ruleApplied, missingFacts, ...) describe the richer, structural
// output of the deterministic engine in packages/agent and are shown here only as context for a human reading
// the table, never compared against the live model's answer.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../agent/config.ts';
import { runLlmTask } from '../agent/llm.ts';
import type { GuardrailCheckOutput } from '../agent/llm-tasks.ts';

const fixturesRoot = fileURLToPath(new URL('../../../fixtures/agent/', import.meta.url));
function readFixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${fixturesRoot}${rel}`, 'utf8')) as Record<string, unknown>;
}

// ---- the confirmed rule, in the API's guardrail_check shape ---------------------------------------------------
// The corrected (v2) version from the scripted teach-back: "the order number goes in as well as the address and
// the delivery window." Every T-case below is checked against this one guardrail; only the screen (and, for T6,
// which customer and what the expert said about them) changes between cases, exactly as in gate.test.ts's
// "full flow" test, where all of T1-T6 run against the same final confirmed map.
const CUSTOMER_07_RULE = {
  id: 'personal-rule-customer-07',
  condition: 'Emailing order delivery details to customer_07',
  requiredAction: 'Write the order number, delivery address and delivery window as text in the email body; the template screenshot alone is not enough',
  reason: 'Customer_07 asked to get it in writing because his phone blocks pictures in our emails',
  quote: "Customer_07 asked me for it in writing, because his phone blocks pictures in our emails. So I spell the details out myself.",
};
// T6: the expert mentions a second customer who wants the same treatment, but admits not knowing why
// (expert-script.json, "scope": "Customer_09 asks for something similar, but I never found out why, so I just
// go along with it."). No reason was ever stated for this one, which is the whole point of the case: a rule the
// expert cannot explain must not be applied with confidence, however similar it looks to a confirmed one.
const CUSTOMER_09_UNEXPLAINED_RULE = {
  id: 'personal-rule-customer-09-unexplained',
  condition: 'Emailing order delivery details to customer_09',
  requiredAction: 'Write the order number, delivery address and delivery window as text in the email body; the template screenshot alone is not enough',
  reason: null,
  quote: 'Customer_09 asks for something similar, but I never found out why, so I just go along with it.',
};

interface GuardrailInput { id: string; condition: string; requiredAction: string; reason: string | null; quote: string | null }
interface CaseSpec {
  id: string;
  customerLabel: string;
  guardrails: GuardrailInput[];
  transcript: Array<{ role: 'expert' | 'agent'; text: string; atMs: number }>;
}

interface Region { id: string; label: string }
interface Observation { id: string; atMs: number; app: string | null; surface: string; summary: string; change: string | null; pendingAction: string | null; regions: Region[] }

/** The email draft from fixtures/agent/teach/<id>.json as a guardrail_check observation: what the screen shows. */
function draftObservation(id: string, customerLabel: string): Observation {
  const t = readFixture(`teach/${id}.json`);
  const draft = t.draft as { bodyText: string; attachTemplateImage: boolean };
  const body = draft.bodyText.trim();
  const bodyDescription = body === '' ? 'The email body is empty.' : `The email body reads:\n${body}`;
  return {
    id: `obs-${id}`,
    atMs: 0,
    app: 'Workspace Mail',
    surface: 'email draft, about to send',
    summary: `Draft email to ${customerLabel} for order ${String(t.orderId)}. ${bodyDescription} The template screenshot is ${draft.attachTemplateImage ? 'attached.' : 'not attached.'}`,
    change: null,
    pendingAction: 'Send',
    regions: [],
  };
}

/** Which customer fixtures/agent/sim/scenario.json's order for this case belongs to, in words for the prompt. */
function customerLabelFor(id: string): string {
  const t = readFixture(`teach/${id}.json`);
  const scenario = readFixture('sim/scenario.json');
  const orders = scenario.orders as Array<{ id: string; customerRef: string | null }>;
  const order = orders.find((o) => o.id === t.orderId);
  if (!order) throw new Error(`${id}: order ${String(t.orderId)} not found in sim/scenario.json`);
  return order.customerRef ?? 'a customer not found in the customer list';
}

const CASES: CaseSpec[] = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => {
  const customerLabel = customerLabelFor(id);
  const t6Transcript: CaseSpec['transcript'] = id === 't6'
    ? [{ role: 'expert', text: 'Customer_09 asks for something similar, but I never found out why, so I just go along with it.', atMs: 0 }]
    : [];
  return {
    id,
    customerLabel,
    guardrails: [id === 't6' ? CUSTOMER_09_UNEXPLAINED_RULE : CUSTOMER_07_RULE],
    transcript: t6Transcript,
  };
});

// ---- run ---------------------------------------------------------------------------------------------------------
interface Row { id: string; title: string; expected: string; got: string; match: boolean; note: string }

async function main(): Promise<void> {
  const runnerUrl = process.env.RUNNER_URL;
  const runnerToken = process.env.RUNNER_TOKEN;
  if (!runnerUrl || !runnerToken) {
    console.log('guardrail-live-check: RUNNER_URL and/or RUNNER_TOKEN are not set; skipping (nothing to check against).');
    return;
  }
  const config = resolveConfig({}, process.env);
  const rows: Row[] = [];
  for (const c of CASES) {
    const expected = readFixture(`expected/${c.id}.json`) as { status: string; policy: string; ruleApplied: boolean; missingFacts: string[] };
    const title = String(readFixture(`teach/${c.id}.json`).title);
    const observation = draftObservation(c.id, c.customerLabel);
    const body = { guardrails: c.guardrails, observations: [observation], transcript: c.transcript, language: null };
    const result = await runLlmTask(config, 'guardrail_check', body, new AbortController().signal);
    const got = result.ok ? (result.output as GuardrailCheckOutput).status : `error: ${result.error}`;
    const message = result.ok ? ((result.output as GuardrailCheckOutput).message ?? '') : '';
    rows.push({
      id: c.id,
      title,
      expected: expected.status,
      got,
      match: got === expected.status,
      note: message || `deterministic suite: policy=${expected.policy} ruleApplied=${expected.ruleApplied} missingFacts=[${expected.missingFacts.join(',')}]`,
    });
  }
  printTable(rows);
  const failed = rows.filter((r) => !r.match);
  if (failed.length > 0) {
    console.log(`\n${failed.length} of ${rows.length} case(s) disagree with the expected status.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${rows.length} case(s) agree with the expected status.`);
  }
}

function printTable(rows: Row[]): void {
  const cols: Array<[keyof Row, string]> = [['id', 'case'], ['title', 'title'], ['expected', 'expected'], ['got', 'got'], ['note', 'note / message']];
  const width = (key: keyof Row, header: string): number => Math.max(header.length, ...rows.map((r) => String(r[key]).length));
  const widths = cols.map(([key, header]) => width(key, header));
  const line = (values: string[]): string => values.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ');
  console.log(line(cols.map(([, header]) => header)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) {
    const mark = r.match ? 'OK  ' : 'FAIL';
    console.log(`${mark}  ${line(cols.map(([key]) => String(r[key])))}`);
  }
}

await main();
