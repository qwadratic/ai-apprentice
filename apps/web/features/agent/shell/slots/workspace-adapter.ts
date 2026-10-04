// The seam between the shell and stream A's demo workspace (doc-9, section 3.2). The shell never imports the workspace: a
// WorkspaceAdapter wraps whatever A exports (createWorkspace + mountDemoWorkspace today, createRuntimeWorkspace later) and the
// slot mounts it into a box it owns. Until an adapter is given the slot shows labelled stand-ins.
//
// What the shell gives the workspace (WorkspaceHost) is only what the workspace needs from the shell; what the workspace gives
// back is typing activity (so that Clipa holds still) and, through its own ScreenBridge and checkpoint adapter, the observations
// and checkpoints that the controller already consumes through ObservationSource.

export interface WorkspaceHost {
  /** The id of the live session, or null before a mode has started. */
  sessionId(): string | null;
  /** The person is off the record: the workspace stops its activity heartbeats and checks. */
  isOffRecord(): boolean;
  /** The person is typing in the workspace (true), or stopped (false). Clipa never starts a flight while this is true. */
  reportInput(typing: boolean): void;
}

export interface WorkspaceAdapter {
  /** Shown in the slot's header, e.g. "demo workspace (stream A)". */
  readonly label: string;
  /** Mounts the workspace into `root`. Returns the cleanup (unmount and dispose). */
  mount(root: HTMLElement, host: WorkspaceHost): () => void;
  /** A new session started (or none): the workspace starts a new task flow. Optional. */
  setSession?(sessionId: string | null): void;
  /** Off the record on or off. Optional. */
  setOffRecord?(on: boolean): void;
}
