// The simulation (TASK-3.32): a synthetic expert for Learn and Review and a synthetic new hire for Teach.
//
//   import { ... } from '../sim/index.ts';                 // Node-safe: personas, mic, shims, driver, workspace adapter
//   import { fetchClip } from '../sim/clip-urls.ts';        // browser only (Vite): where the mp3 clips are served from
//   import { mountSimDesktop } from '../sim/desktop/desktop.ts';   // browser only: the simulated desktop frame
//
// How the shell uses it, only when the page was opened with ?sim=expert or ?sim=newhire (nothing is installed otherwise):
//   1. const mic = createSyntheticMic({ loadClip: fetchClip });  installSimMediaIfRequested(location.search, { mic });
//      before the voice session and the screen capture start, so both find the synthetic devices.
//   2. const desktop = mountSimDesktop(slot, { persona });  mount the workspace into desktop.workspaceHost.
//   3. const driver = createPersonaDriver({ persona, workspace: createDemoWorkspaceActions({ port: createDomPort(desktop.workspaceHost, desktop.cursor), clock }), mic, clock, onLog });
//   4. From the voice session: driver.setAgentSpeaking(true/false) while the agent talks, and
//      driver.onAgentAsk(topic, text) when the agent has asked a question (the topic is the brain's: reason, essentials,
//      guardrail, scope, exception, why_stop, duration, teachback; in Teach: predict, why_hold, explain).
//   5. driver.run(EXPERT_LEARN) for the Learn task, driver.run(NEW_HIRE_T1) for Teach T1.
//
// The persona's knowledge lives only in personas.ts and is spoken, never put into a prompt or a knowledge base.
export { createRealClock, createRng } from './clock.ts';
export type { Clock } from './clock.ts';
export { EXPERT, NEW_HIRE, PERSONAS, PERSONA_TOPICS, clipIdOf, getPersona, pickLine, validatePersona } from './personas.ts';
export type { Persona, PersonaId, PersonaLine, PersonaTopic, PersonaVoice, PickedLine } from './personas.ts';
export { MicStoppedError, createSyntheticMic } from './synthetic-mic.ts';
export type { AudioContextLike, MicEvent, SyntheticMic, SyntheticMicOptions } from './synthetic-mic.ts';
export { CURRENT_TAB_OPTIONS, SimMediaInstalledError, installSimMedia, installSimMediaIfRequested, simModeFromSearch } from './sim-media.ts';
export type { InstallSimMediaOptions, InstalledSimMedia, MediaDevicesLike } from './sim-media.ts';
export { createPersonaDriver } from './driver.ts';
export type { AnsweredQuestion, DriverLog, PersonaDriver, PersonaDriverOptions, TaskReport } from './driver.ts';
export { EXPERT_LEARN, NEW_HIRE_T1, NEW_HIRE_T2, NEW_HIRE_T3, NEW_HIRE_T4, TASKS } from './tasks.ts';
export type { TaskScript, TaskStep } from './tasks.ts';
export { DEMO_SELECTORS, createDemoWorkspaceActions, createDomPort } from './workspace-dom.ts';
export type { DomPort, PointerLike } from './workspace-dom.ts';
export type { CheckResult, CheckStatus, EmailView, OrderView, TextTarget, WorkspaceActions } from './workspace-actions.ts';
export { HUMAN_TYPING, planTyping, typeLikeAHuman } from './typing.ts';
export type { TypingProfile } from './typing.ts';
