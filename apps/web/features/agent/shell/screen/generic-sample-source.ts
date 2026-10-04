// WIP (TASK-3.37): the synthetic screen_activity source (a mail-client script, labelled synthetic) is not written yet. The id exists
// so the controller can ask for it; runtime.ts falls back to the neutral sample until the source lands.
import type { SampleScenarioId } from './sample-scenarios.ts';

export type SampleSourceId = SampleScenarioId | 'generic';
