import type { ScreenBridge } from '@apprentice/contracts';

/**
 * Where screen observations come from. Stream A's real bridge (createScreenBridge, doc-9 section 2.1) will implement
 * this by adding a label and dispose(); until then the only source is the synthetic sample one.
 */
export interface ObservationSource extends ScreenBridge {
  /** Shown in the status bar and the debug drawer. */
  readonly label: string;
  /** true: invented data, never presented as the person's screen. */
  readonly synthetic: boolean;
  /** Synthetic sources can raise a sample checkpoint on demand (Teach). Real sources do not have this. */
  raiseSampleCheckpoint?(): void;
  /** A live source coordinates the workspace and the capture for the off-the-record switch. Optional. */
  setOffRecord?(on: boolean): Promise<void>;
  /** Stops timers and listeners. Idempotent. */
  dispose(): void;
}
