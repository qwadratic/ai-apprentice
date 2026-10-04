// The seeded demo map: what Reflect shows when neither this session nor an earlier one has a map (doc: docs/pitch/demo-script.md).
// Synthetic and labelled so on the board ("Demo session (synthetic)"): the two processes of the demo script, Lumen's payment
// terms and the prepaid licence spread by quarter, with the expert's words as the script has them. No screen moments: it was
// never seen on a screen, so it names no evidence. Same shape as a built map (MapSynthesisOutput).
import type { MapSynthesisOutput } from '../llm-tasks.ts';

const DEMO_MAP: MapSynthesisOutput = {
  processes: [
    { id: 'p1', title: 'Invoice email: payment terms', summary: 'Reply to a customer with their invoice and set the payment terms their agreement allows.' },
    { id: 'p2', title: 'Prepaid cost: spread by quarter', summary: 'Spread a prepaid annual cost across the quarters it covers in the budget sheet.' },
  ],
  steps: [
    {
      id: 's1', processId: 'p1', kind: 'action', goal: 'Reply to Lumen Bakery with their invoice',
      action: 'Opened the draft reply to billing@lumen-bakery.example, subject "Invoice INV-2207"', decision: null, evidenceIds: [],
    },
    {
      id: 's2', processId: 'p1', kind: 'action', goal: 'Check the payment terms before sending',
      action: 'Read the last line of the draft: "Payment terms: Net 14."', decision: null, evidenceIds: [],
    },
    {
      id: 's3', processId: 'p1', kind: 'judgment', goal: 'Give Lumen the terms of its agreement', action: 'Changed "Net 14" to "Net 30"',
      decision: {
        summary: 'Net 30 instead of the standard Net 14, for Lumen only',
        reason: 'Lumen has a signed agreement for Net 30',
        quote: 'Lumen has a signed agreement for Net 30. Standard is Net 14, and Net 30 is only for Lumen.',
        quoteAtMs: null,
      },
      evidenceIds: [],
    },
    { id: 's4', processId: 'p1', kind: 'action', goal: 'Send the invoice', action: 'Sent the reply with the invoice', decision: null, evidenceIds: [] },
    {
      id: 's5', processId: 'p2', kind: 'action', goal: 'Find the prepaid cost in the budget',
      action: 'Opened the sheet "Software budget 2027" at "Design suite licence (prepaid 12 months)", 12,000 a year', decision: null, evidenceIds: [],
    },
    {
      id: 's6', processId: 'p2', kind: 'judgment', goal: 'Show the cost in the quarters it covers', action: 'Typed 3,000 into Q1, Q2, Q3 and Q4',
      decision: {
        summary: 'Spread the 12,000 evenly across the four quarters',
        reason: 'The licence is prepaid for twelve months; all of it in Q1 would look like an overspend',
        quote: 'Она предоплачена на двенадцать месяцев. Если поставить всё в первый квартал, он выглядит как перерасход.',
        quoteAtMs: null,
      },
      evidenceIds: [],
    },
  ],
  guardrails: [
    {
      id: 'g1', processId: 'p1', condition: 'Payment terms other than the standard Net 14 on an invoice email',
      requiredAction: 'Net 30 only for Lumen Bakery; longer terms, or Net 30 for anyone else, need the finance lead',
      reason: 'Only Lumen has a signed agreement for Net 30',
      quote: 'Standard is Net 14, and Net 30 is only for Lumen. Anything longer needs the finance lead.',
      quoteAtMs: null, escalateTo: 'the finance lead', exceptions: [], evidenceIds: [],
    },
    {
      id: 'g2', processId: 'p1', condition: 'An invoice email to Lumen Bakery still says Net 14',
      requiredAction: 'Change the payment terms to Net 30 before sending',
      reason: 'Lumen has a signed agreement for Net 30',
      quote: 'Lumen has a signed agreement for Net 30.',
      quoteAtMs: null, escalateTo: null, exceptions: [], evidenceIds: [],
    },
    {
      id: 'g3', processId: 'p2', condition: 'A prepaid cost over EUR 1,000 in the budget sheet',
      requiredAction: 'Spread it across the quarters it covers instead of booking it all in one quarter',
      reason: 'All of it in one quarter makes that quarter look like an overspend',
      quote: 'Так только для предоплат больше тысячи евро.',
      quoteAtMs: null, escalateTo: null, exceptions: ['A prepaid cost of EUR 1,000 or less stays in the quarter it is paid'], evidenceIds: [],
    },
  ],
  gaps: [
    { question: 'Is Net 30 only for Lumen, or for any customer with a signed agreement? Who checks the agreement?', targetId: 'g1', evidenceIds: [], regionIds: [] },
    { question: 'Is EUR 1,000 the exact limit for spreading a prepaid cost, and does it apply to licences only?', targetId: 'g3', evidenceIds: [], regionIds: [] },
  ],
  teachBack:
    'Here is what I understood. Invoice emails use the standard Net 14. Lumen Bakery gets Net 30 because it has a signed agreement, '
    + 'and only Lumen: longer terms, or Net 30 for anyone else, need the finance lead. In the budget sheet, a prepaid cost over '
    + '1,000 euros is spread across the quarters it covers, so no quarter looks overspent; smaller amounts stay where they are paid. Is that right?',
};

/** A fresh copy of the demo map: edits in one session never change it for the next. */
export function demoMap(): MapSynthesisOutput {
  return structuredClone(DEMO_MAP);
}
