// Everything environment-specific lives here. The footer links in static/index.html repeat three of these URLs.

export const REPO = 'qwadratic/ai-apprentice';
export const REPO_URL = `https://github.com/${REPO}`;
export const PULLS_URL = `${REPO_URL}/pulls`;
export const MERGE_QUEUE_URL = `${PULLS_URL}?q=is%3Apr+is%3Aopen+label%3Aready-to-merge`;
export const ACTIONS_RELEASE_URL = `${REPO_URL}/actions/workflows/release.yml`;
export const BACKLOG_TASKS_URL = `${REPO_URL}/tree/main/backlog/tasks`;

export const prUrl = (number: number): string => `${REPO_URL}/pull/${number}`;
export const commitUrl = (sha: string): string => `${REPO_URL}/commit/${sha}`;

// Open PRs, read without a token (public repository, CORS allowed). Anonymous requests are limited
// to 60 per hour per IP address, so the list is fetched once at load and on Refresh, never on a timer.
export const PULLS_PAGE_SIZE = 50;
export const PULLS_API_URL = `https://api.github.com/repos/${REPO}/pulls?state=open&per_page=${PULLS_PAGE_SIZE}`;

// The VM API. Its CORS allow-list holds this page's origin (https://qwadratic.github.io), the same as for the product app.
export const API_BASE = 'https://apprentice.exe.xyz';
export const HEALTH_URL = `${API_BASE}/health`;
// Runner state and the shas: apps/api reports them here (the infra ops module). The placeholder API that served
// the VM before has them in /health itself and answers 404 here; status.ts then falls back to /health.
export const VM_HEALTH_URL = `${API_BASE}/ops/vm-health`;
export const OPS_STATUS_URL = `${API_BASE}/ops/deploy/status`;

// Written next to this page by release.yml: {"sha": "<40 hex>", "at": "<ISO time>", "run": "<run url>"}.
export const DEPLOY_JSON_URL = '../deploy.json'; // the status page lives under status/, deploy.json at the site root

export const FETCH_TIMEOUT_MS = 5000;
