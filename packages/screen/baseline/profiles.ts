export type BaselineAppId = 'gmail' | 'google_sheets' | 'google_maps';
export type BaselineProfileId =
  | 'baseline.gmail-ticket-reply'
  | 'baseline.sheets-quarterly-report'
  | 'baseline.maps-business-venue';

export interface BaselineProfile {
  readonly id: BaselineProfileId;
  readonly appId: BaselineAppId;
  readonly appIdentifiers: readonly string[];
  readonly workflow: readonly string[];
  /** App recognition proposes this workflow; it does not establish that the workflow is in scope. */
  readonly scopePolicy: string;
}

function profile(value: BaselineProfile): BaselineProfile {
  return Object.freeze({
    ...value,
    appIdentifiers: Object.freeze([...value.appIdentifiers]),
    workflow: Object.freeze([...value.workflow]),
  });
}

export const BASELINE_PROFILES: Readonly<Record<BaselineAppId, BaselineProfile>> = Object.freeze({
  gmail: profile({
    id: 'baseline.gmail-ticket-reply',
    appId: 'gmail',
    appIdentifiers: ['Gmail'],
    workflow: [
      'Read the customer email.',
      'Prepare a reply with a greeting, billing period, invoice date, and the matching PDF invoice attached.',
      'Check that the reply data agrees with the invoice.',
    ],
    scopePolicy: 'Use as a candidate only when the visible work or the expert establishes customer invoice-ticket scope; otherwise clarify the workflow.',
  }),
  google_sheets: profile({
    id: 'baseline.sheets-quarterly-report',
    appId: 'google_sheets',
    appIdentifiers: ['Google Sheets'],
    workflow: [
      'Select client invoices by invoice date for the target quarter.',
      'Calculate billed amount, received payments against those selected invoices, and unpaid balance per company, then calculate totals.',
      'Check that unpaid balance equals billed amount minus payments.',
    ],
    scopePolicy: 'Use as a candidate only when the visible work or the expert establishes quarterly invoice-reporting scope; otherwise clarify the workflow.',
  }),
  google_maps: profile({
    id: 'baseline.maps-business-venue',
    appId: 'google_maps',
    appIdentifiers: ['Google Maps'],
    workflow: [
      'Compare places for a business meeting.',
      'Select a venue with a rating of at least 4.5.',
    ],
    scopePolicy: 'Use as a candidate only when the visible work or the expert establishes business-meeting venue scope; otherwise clarify the workflow.',
  }),
});

const APP_BY_IDENTIFIER = new Map<string, BaselineAppId>(
  Object.values(BASELINE_PROFILES).flatMap((item) => item.appIdentifiers.map((identifier) => [identifier.toLocaleLowerCase('en-US'), item.appId] as const)),
);

export interface BaselineObservation {
  readonly id: string;
  readonly app: string | null;
  readonly surface: string;
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

export type BaselineStatus = 'empty' | 'confirming' | 'candidate' | 'suspended';
export type BaselineBasis = 'none' | 'awaiting_distinct_observation' | 'candidate_scope_requires_confirmation' | 'unknown_or_ambiguous_app';

export interface BaselineCandidate {
  readonly appId: BaselineAppId;
  readonly profileId: BaselineProfileId;
  readonly observationIds: readonly string[];
}

export interface BaselineEvidence {
  readonly observationIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface BaselineSnapshot {
  readonly appId: BaselineAppId | null;
  readonly profileId: BaselineProfileId | null;
  readonly candidate: BaselineCandidate | null;
  readonly status: BaselineStatus;
  readonly evidence: BaselineEvidence;
  readonly basis: BaselineBasis;
}

function snapshot(value: BaselineSnapshot): BaselineSnapshot {
  const evidence = Object.freeze({
    observationIds: Object.freeze([...value.evidence.observationIds]),
    evidenceIds: Object.freeze([...value.evidence.evidenceIds]),
  });
  const candidate = value.candidate === null ? null : Object.freeze({
    ...value.candidate,
    observationIds: Object.freeze([...value.candidate.observationIds]),
  });
  return Object.freeze({...value, candidate, evidence});
}

const EMPTY = snapshot({appId: null, profileId: null, candidate: null, status: 'empty', evidence: {observationIds: [], evidenceIds: []}, basis: 'none'});

function appFor(value: string | null): BaselineAppId | null {
  return value === null ? null : APP_BY_IDENTIFIER.get(value.trim().toLocaleLowerCase('en-US')) ?? null;
}

interface StoredObservation {
  readonly id: string;
  readonly app: string | null;
  readonly evidenceIds: readonly string[];
}

function stored(observation: BaselineObservation): StoredObservation {
  return Object.freeze({
    id: observation.id,
    app: observation.app,
    evidenceIds: Object.freeze([...observation.evidenceIds].slice(0, 8)),
  });
}

function evidence(observations: readonly StoredObservation[]): BaselineEvidence {
  return {
    observationIds: observations.slice(-2).map((item) => item.id),
    evidenceIds: [...new Set(observations.flatMap((item) => item.evidenceIds))].slice(-8),
  };
}

export interface BaselinePromptContext {
  readonly source: 'supplied_baseline';
  readonly learned: false;
  readonly appId: BaselineAppId;
  readonly profileId: BaselineProfileId;
  readonly workflow: readonly string[];
  readonly scopePolicy: string;
  readonly evidence: BaselineEvidence;
}

/** Build question context only after stable app recognition; this never represents expert-confirmed knowledge. */
export function baselinePromptContext(value: BaselineSnapshot): BaselinePromptContext | null {
  if (value.status !== 'candidate' || value.appId === null || value.profileId === null) return null;
  const item = BASELINE_PROFILES[value.appId];
  if (item.id !== value.profileId) return null;
  return Object.freeze({
    source: 'supplied_baseline',
    learned: false,
    appId: item.appId,
    profileId: item.id,
    workflow: item.workflow,
    scopePolicy: item.scopePolicy,
    evidence: Object.freeze({
      observationIds: Object.freeze([...value.evidence.observationIds]),
      evidenceIds: Object.freeze([...value.evidence.evidenceIds]),
    }),
  });
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function contextRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid baseline context ${field}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) throw new TypeError(`Invalid baseline context ${field}`);
}

function safeIds(value: unknown, limit: number, field: string): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some((id) => typeof id !== 'string' || !SAFE_ID.test(id)) || new Set(value).size !== value.length) {
    throw new TypeError(`Invalid baseline context ${field}`);
  }
  return [...value] as string[];
}

/** Strict LLM-boundary parser. Catalog-owned workflow prose is verified and rebuilt from the local catalog. */
export function parseBaselinePromptContext(value: unknown): BaselinePromptContext | null {
  if (value === null || value === undefined) return null;
  const input = contextRecord(value, 'value');
  exactKeys(input, ['source', 'learned', 'appId', 'profileId', 'workflow', 'scopePolicy', 'evidence'], 'fields');
  if (input.source !== 'supplied_baseline' || input.learned !== false) throw new TypeError('Invalid baseline context provenance');
  if (typeof input.appId !== 'string' || !(input.appId in BASELINE_PROFILES)) throw new TypeError('Invalid baseline context appId');
  const item = BASELINE_PROFILES[input.appId as BaselineAppId];
  if (input.profileId !== item.id) throw new TypeError('Invalid baseline context profileId');
  if (!Array.isArray(input.workflow) || input.workflow.length !== item.workflow.length || input.workflow.some((line, index) => line !== item.workflow[index])) {
    throw new TypeError('Invalid baseline context workflow');
  }
  if (input.scopePolicy !== item.scopePolicy) throw new TypeError('Invalid baseline context scopePolicy');
  const rawEvidence = contextRecord(input.evidence, 'evidence');
  exactKeys(rawEvidence, ['observationIds', 'evidenceIds'], 'evidence fields');
  const observationIds = safeIds(rawEvidence.observationIds, 2, 'observationIds');
  const evidenceIds = safeIds(rawEvidence.evidenceIds, 8, 'evidenceIds');
  return Object.freeze({
    source: 'supplied_baseline',
    learned: false,
    appId: item.appId,
    profileId: item.id,
    workflow: item.workflow,
    scopePolicy: item.scopePolicy,
    evidence: Object.freeze({
      observationIds: Object.freeze(observationIds),
      evidenceIds: Object.freeze(evidenceIds),
    }),
  });
}

/**
 * Selects an app-specific baseline candidate. The caller must establish visible or expert-confirmed workflow scope
 * before using the profile to judge a deviation. Learned process IDs belong to the agent layer and never enter here.
 */
export class BaselineProfileSelector {
  #value: BaselineSnapshot = EMPTY;
  #observations: StoredObservation[] = [];

  current(): BaselineSnapshot { return this.#value; }

  reset(): BaselineSnapshot {
    this.#observations = [];
    this.#value = EMPTY;
    return this.#value;
  }

  observe(observation: BaselineObservation): BaselineSnapshot {
    const retained = stored(observation);
    const appId = appFor(retained.app);
    if (appId === null) {
      this.#observations = [];
      this.#value = snapshot({
        appId: null,
        profileId: null,
        candidate: null,
        status: 'suspended',
        evidence: evidence([retained]),
        basis: 'unknown_or_ambiguous_app',
      });
      return this.#value;
    }

    const profile = BASELINE_PROFILES[appId];
    const prior = this.#observations.at(-1);
    if (!prior || appFor(prior.app) !== appId) this.#observations = [retained];
    else if (prior.id !== retained.id) this.#observations = [...this.#observations.slice(-1), retained];

    if (this.#observations.length < 2) {
      this.#value = snapshot({
        appId: null,
        profileId: null,
        candidate: {appId, profileId: profile.id, observationIds: this.#observations.map((item) => item.id)},
        status: 'confirming',
        evidence: evidence(this.#observations),
        basis: 'awaiting_distinct_observation',
      });
      return this.#value;
    }

    this.#value = snapshot({
      appId,
      profileId: profile.id,
      candidate: {appId, profileId: profile.id, observationIds: this.#observations.map((item) => item.id)},
      status: 'candidate',
      evidence: evidence(this.#observations),
      basis: 'candidate_scope_requires_confirmation',
    });
    return this.#value;
  }
}
