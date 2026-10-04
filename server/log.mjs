const SECRET_KEYS = /password|token|secret|authorization|cookie|api[_-]?key|cvv|pin/i;

export function logEvent(event, fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEYS.test(key)) continue;
    if (value instanceof Error) {
      safe[key] = value.code || value.name || 'error';
      continue;
    }
    safe[key] = value;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...safe }));
}
