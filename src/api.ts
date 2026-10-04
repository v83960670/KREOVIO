export type Account = {
  authenticated: boolean;
  email?: string;
  emailVerified?: boolean;
  csrf?: string;
  creditsAvailable?: number;
  plan?: { id: string; name: string; is_unlimited?: boolean };
  verificationDelivery?: string;
};

export class ApiError extends Error {
  status: number;
  code?: string;
  payload?: Record<string, unknown>;
  constructor(message: string, status: number, code?: string, payload?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.message ?? 'The request could not be completed.', response.status, payload.code, payload);
  return payload as T;
}

export async function streamSearch(body: Record<string, string>, csrf: string, onEvent: (event: string, data: Record<string, unknown>) => void) {
  const response = await fetch('/api/search', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-CSRF-Token': csrf,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(payload.message ?? 'The search could not be started.', response.status, payload.code, payload);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let report: Record<string, unknown> | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const event = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
      if (!event || !data) continue;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      onEvent(event, parsed);
      if (event === 'report') report = parsed;
      if (event === 'search_failed') throw new ApiError(String(parsed.message ?? 'The search did not complete.'), 500, String(parsed.code ?? 'SEARCH_FAILED'), parsed);
    }
  }
  return report;
}

export function formatAge(iso?: string | null) {
  if (!iso) return 'No successful collection';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `Updated ${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `Updated ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Updated ${hours} hours ago`;
  return `Updated ${Math.round(hours / 24)} days ago`;
}

export const STAGE_LABELS: Record<string, string> = {
  search_started: 'Search started',
  entitlement_checked: 'Entitlement checked',
  credit_reserved: 'One search credit reserved',
  cache_checked: 'Recent cache checked',
  collecting_sources: 'Collecting signals',
  source_completed: 'Source collection completed',
  normalizing: 'Normalizing records',
  deduplicating: 'Removing duplicates',
  clustering: 'Clustering related topics',
  comparing_history: 'Comparing historical movement',
  calculating_momentum: 'Measuring acceleration',
  scoring: 'Calculating Trend Score',
  verifying: 'Cross-checking sources',
  results_ready: 'Results ready',
  credit_released: 'Reserved credit released',
};
