// The simulation's own page (dev server: /features/agent/sim/entry/index.html?sim=expert or ?sim=newhire).
// It is a harness around the same parts the product shell uses later: the simulated desktop with stream A's demo workspace
// in it, the synthetic microphone, the two shims, and the persona driver. The agent here is a STUB (stub-agent.ts), so a
// whole run needs no ElevenLabs, brain or network. The page says so, and it says the persona is synthetic.
//
// Query: ?sim=expert|newhire (required: without it nothing is installed and the page only explains itself),
//        ?monitor=1 plays the persona's voice through the speakers, ?speed=N compresses waits (clips still play in real time).
// Start needs a click: getDisplayMedia and the audio context need a user gesture.
import { createDemoWorkspaceActions, createDomPort } from '../workspace-dom.ts';
import { createWorkspace, mountDemoWorkspace } from '../../../demo-workspace/index.ts';
import type { CheckpointPort } from '../../../demo-workspace/index.ts';
import '../../../demo-workspace/workspace.css';
import { allClipIds, fetchClip } from '../clip-urls.ts';
import { createRealClock } from '../clock.ts';
import { createPersonaDriver } from '../driver.ts';
import type { DriverLog, TaskReport } from '../driver.ts';
import { PERSONAS } from '../personas.ts';
import type { Persona } from '../personas.ts';
import { installSimMediaIfRequested, simModeFromSearch } from '../sim-media.ts';
import type { InstalledSimMedia } from '../sim-media.ts';
import { createSyntheticMic } from '../synthetic-mic.ts';
import { EXPERT_LEARN, NEW_HIRE_T1 } from '../tasks.ts';
import { mountSimDesktop } from '../desktop/desktop.ts';
import '../desktop/desktop.css';
import './entry.css';
import { startCaptureProbe, startEars } from './probes.ts';
import type { CaptureReport, EarsReport } from './probes.ts';
import { createStubAgent } from './stub-agent.ts';

/** What the page exposes to the e2e script and to anyone who opens the console. */
export interface SimPageState {
  status: 'idle' | 'running' | 'done' | 'failed';
  persona: string | null;
  logs: Array<{ atMs: number; source: string; text: string }>;
  report: TaskReport | null;
  answered: Array<{ topic: string; clipId: string; known: boolean }>;
  asked: Array<{ topic: string; text: string }>;
  mediaCalls: InstalledSimMedia['calls'];
  capture: CaptureReport | null;
  ears: EarsReport | null;
  error: string | null;
  workspace: { sent: boolean; ticket: string; attachments: number; check: string } | null;
}

declare global {
  interface Window {
    __sim?: SimPageState;
  }
}

const params = new URLSearchParams(location.search);
const speed = Number(params.get('speed') ?? '1') || 1;
const personaId = simModeFromSearch(location.search);
const root = document.getElementById('sim-root');
if (!root) throw new Error('the page has no #sim-root');

const state: SimPageState = {
  status: 'idle',
  persona: personaId,
  logs: [],
  report: null,
  answered: [],
  asked: [],
  mediaCalls: [],
  capture: null,
  ears: null,
  error: null,
  workspace: null,
};
window.__sim = state;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

if (personaId === null) {
  root.append(
    el('h1', 'sim-h1', 'Simulation harness'),
    el('p', 'sim-p', 'Open this page with ?sim=expert (Learn) or ?sim=newhire (Teach). Without the parameter nothing is installed and the page does nothing.'),
  );
} else {
  void boot(PERSONAS[personaId]);
}

async function boot(persona: Persona): Promise<void> {
  const clock = createRealClock(speed);
  const layout = el('div', 'sim-layout');
  const stage = el('div', 'sim-stage');
  const side = el('aside', 'sim-side');
  layout.append(stage, side);
  root!.append(layout);

  const title = el('h1', 'sim-h1', 'Simulation harness');
  const who = el('p', 'sim-who', `${persona.displayName}. The voice, the answers and the screen work are scripted; no real person is involved.`);
  const stubNote = el('p', 'sim-stub', 'The agent here is a STUB (a test double). It asks fixed questions at pauses and answers the Preview check by a fixed rule. It is not the real agent.');
  const start = el('button', 'sim-start-button', persona.id === 'expert' ? 'Start the synthetic expert (Learn)' : 'Start the synthetic new hire (Teach T1)');
  start.type = 'button';
  start.dataset['simStart'] = '';
  const status = el('p', 'sim-status', 'Ready.');
  status.setAttribute('role', 'status');
  const logList = el('ol', 'sim-log');
  logList.setAttribute('aria-label', 'What happened');
  side.append(title, who, stubNote, start, status, logList);

  const addLog = (source: string, text: string): void => {
    const entry = { atMs: Math.round(clock.now()), source, text };
    state.logs.push(entry);
    const item = el('li', `sim-log-${source}`);
    item.append(el('span', 'sim-log-src', source), document.createTextNode(` ${text}`));
    logList.append(item);
    item.scrollIntoView({ block: 'nearest' });
  };

  const mode = persona.id === 'expert' ? 'learn' : 'teach';
  const desktop = mountSimDesktop(stage, { persona, clock });
  // The stub reads the workspace through this view; the real agent will see pixels instead.
  let stub: ReturnType<typeof createStubAgent> | null = null;
  const checkpoint: CheckpointPort = {
    async observeCurrentScreen(scope) {
      await clock.sleep(400);
      return { scope, orderId: 'stub-observation-order', emailId: 'stub-observation-email' };
    },
    async evaluate() {
      await clock.sleep(1200);
      const verdict = stub?.evaluate() ?? { status: 'unknown' as const, message: 'STUB TUTOR (test double): not started.' };
      return { status: verdict.status, message: verdict.message, evidenceIds: [] };
    },
  };
  const workspace = createWorkspace({
    sessionId: `sim-${persona.id}`,
    checkpoint,
    // Only typing counts as activity: the workspace also reports idle every 2 s for a while after the last key.
    onInputActivity: (activity) => {
      if (activity.typing) stub?.noteActivity();
    },
  });
  const unmountWorkspace = mountDemoWorkspace(desktop.workspaceHost, workspace);
  desktop.root.addEventListener('click', () => stub?.noteActivity(), true);
  desktop.root.addEventListener('input', () => stub?.noteActivity(), true);
  const view = () => {
    const s = workspace.getState();
    return {
      orderId: s.order.id,
      customer: s.order.customerRef,
      address: s.order.deliveryAddress,
      window: s.order.deliveryWindow,
      body: s.draft.body,
      attachments: s.draft.attachments.length,
      check: s.check.status,
      caseId: s.caseId,
    };
  };
  const readWorkspace = (): NonNullable<SimPageState['workspace']> => {
    const s = workspace.getState();
    return { sent: s.sent !== null, ticket: s.ticket.status, attachments: s.draft.attachments.length, check: s.check.status };
  };
  state.workspace = readWorkspace();

  start.addEventListener('click', () => {
    start.disabled = true;
    state.status = 'running';
    status.textContent = 'Running: the persona is working in the workspace.';
    // The click is the user gesture the audio context and the screen share need: start them in this handler.
    void run();
  });

  async function run(): Promise<void> {
    let media: InstalledSimMedia | null = null;
    let ears: ReturnType<typeof startEars> | null = null;
    let capture: Awaited<ReturnType<typeof startCaptureProbe>> | null = null;
    const mic = createSyntheticMic({
      loadClip: fetchClip,
      monitor: params.get('monitor') === '1',
      onEvent: (e) => {
        if (e.type === 'start' || e.type === 'end') addLog('mic', `${e.type} ${e.clipId}`);
      },
    });
    try {
      const installed = installSimMediaIfRequested(location.search, { mic });
      if (!installed) throw new Error('?sim= is not set: the shims were not installed');
      media = installed.media;
      state.mediaCalls = media.calls;
      addLog('sim', 'shims installed: getUserMedia (audio) is the synthetic mic, getDisplayMedia asks for this tab');

      // Consume the devices the way the product does. The screen share goes first: it needs the click's user activation.
      capture = await startCaptureProbe(navigator.mediaDevices);
      await mic.resume();
      await mic.preload(allClipIds().filter((id) => id.startsWith(`${persona.id}.`)));
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ears = startEars(micStream, clock);
      addLog('sim', 'screen share and microphone started');

      const workspaceActions = createDemoWorkspaceActions({ port: createDomPort(desktop.workspaceHost, desktop.cursor), clock });
      const driver = createPersonaDriver({
        persona,
        workspace: workspaceActions,
        mic,
        clock,
        onLog: (entry: DriverLog) => {
          if (entry.kind === 'step' || entry.kind === 'agent_speaking') return;
          addLog('persona', `${entry.kind}: ${entry.text}`);
        },
      });
      stub = createStubAgent({
        mode,
        driver,
        clock,
        view,
        log: (entry) => addLog('agent', entry.text),
      });
      stub.start();
      const report = await driver.run(persona.id === 'expert' ? EXPERT_LEARN : NEW_HIRE_T1);
      // A last look at the desktop, so the final state is on screen before the run is called done.
      await clock.sleep(2500);
      stub.stop();
      state.report = report;
      state.answered = driver.answered.map((a) => ({ topic: a.topic, clipId: a.clipId, known: a.known }));
      state.asked = [...stub.asked];
      state.capture = capture.report();
      state.ears = ears.report();
      state.workspace = readWorkspace();
      state.status = 'done';
      status.textContent = `Done. ${state.answered.length} answers played from the synthetic microphone.`;
      addLog('sim', 'run finished');
    } catch (error) {
      state.status = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      status.textContent = `Failed: ${state.error}`;
      addLog('error', state.error);
    } finally {
      stub?.stop();
      ears?.stop();
      capture?.stop();
      mic.stop();
      media?.restore();
      document.body.dataset['simStatus'] = state.status;
    }
  }

  window.addEventListener('pagehide', () => {
    unmountWorkspace();
  });
}
