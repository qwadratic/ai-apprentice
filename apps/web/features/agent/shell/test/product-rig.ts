// A rig with the product's wiring: the real AgentBrain over packages/agent and the sample scenarios (the customer_07 Learn run,
// the Teach cases), on fake timers and a fake voice.
import { AgentBrain } from '../brain/agent-brain.ts';
import { SAMPLE_CUSTOMERS } from '../screen/sample-scenarios.ts';
import { createRig, modernApi } from './helpers.ts';
import type { Rig, Responder } from './helpers.ts';

export function productRig(responders: Responder[] = [modernApi()]): Rig {
  return createRig({ scenarios: true, responders, createBrain: (log) => new AgentBrain({ log, customers: SAMPLE_CUSTOMERS }) });
}
