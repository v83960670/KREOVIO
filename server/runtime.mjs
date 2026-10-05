export function assertProductionConfig(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  for (const name of ['DATABASE_URL','AUTH_SECRET','APP_ORIGIN','EMAIL_API_KEY','EMAIL_FROM']) {
    if (!env[name]) throw Object.assign(new Error(`Production requires ${name}.`), {code:'PRODUCTION_CONFIGURATION_REQUIRED'});
  }
  if (env.AUTH_SECRET.length < 32 || !env.APP_ORIGIN.startsWith('https://') || env.COOKIE_SECURE !== 'true') throw new Error('Production requires a strong AUTH_SECRET, HTTPS origin and secure cookies.');
}

// Shared PostgreSQL limiter: atomic across API replicas; DB failure fails closed.
export async function allowRequest(pool, key, limit, windowMs = 60_000) {
  const result = await pool.query(`INSERT INTO request_limits(key,window_start,count) VALUES($1,now(),1)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN request_limits.window_start <= now()-($2*interval '1 millisecond') THEN 1 ELSE request_limits.count+1 END,
      window_start=CASE WHEN request_limits.window_start <= now()-($2*interval '1 millisecond') THEN now() ELSE request_limits.window_start END
    RETURNING count`, [key,windowMs]);
  return result.rows[0].count <= limit;
}

export async function deliverVerification(email, token) {
  if (!process.env.EMAIL_API_KEY) {
    if (process.env.NODE_ENV === 'production') throw new Error('Production email is not configured.');
    return 'local-mailbox';
  }
  const response = await fetch('https://api.resend.com/emails', {
    method:'POST', headers:{Authorization:`Bearer ${process.env.EMAIL_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({from:process.env.EMAIL_FROM,to:[email],subject:'Verify your Kreovio account',
      text:`Enter this verification code in Kreovio: ${token}\nThis code expires in 24 hours. If you did not create an account, ignore this message.`}),
    signal:AbortSignal.timeout(12000),
  });
  if (!response.ok) return 'delivery-failed';
  return 'email';
}
