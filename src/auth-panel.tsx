import { FormEvent, useState } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { api, ApiError, type Account } from './api';

export default function AuthPanel({ account, onChange }: { account: Account | null; onChange: (account: Account) => void }) {
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(false);
    try {
      if (mode === 'register') {
        const created = await api<Account & { verificationToken?: string; message?: string }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        if (created.verificationToken) setToken(created.verificationToken);
        setMessage(created.message ?? 'Account created. Verify it before the free search is granted.');
        const me = await api<Account>('/api/auth/me');
        onChange(me);
      } else {
        await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        onChange(await api<Account>('/api/auth/me'));
        setMessage('Signed in. Credits are enforced on the server.');
      }
    } catch (reason) {
      setError(true);
      setMessage(reason instanceof ApiError ? reason.message : 'The account request failed.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(false);
    try {
      await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) });
      onChange(await api<Account>('/api/auth/me'));
      setMessage('Verified. One free Trend Search is now on this account.');
    } catch (reason) {
      setError(true);
      setMessage(reason instanceof ApiError ? reason.message : 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(false);
    try {
      const result = await api<{delivery: string; verificationToken?: string}>('/api/auth/resend-verification', {
        method: 'POST', headers: {'X-CSRF-Token': account?.csrf ?? ''},
      });
      if (result.verificationToken) setToken(result.verificationToken);
      setMessage(result.delivery === 'email' ? 'A new verification code was emailed to you.' : result.delivery === 'local-mailbox' ? 'A new local verification code is ready.' : 'Email delivery failed. Please try again later.');
    } catch {setError(true); setMessage('Could not resend verification. Please try again later.');}
    finally {setBusy(false);}
  };

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    onChange({ authenticated: false });
    setMessage('');
  };

  if (account?.authenticated) {
    return (
      <div className="auth-panel">
        <span className="eyebrow">ACCOUNT</span>
        <strong>{account.email}</strong>
        <p>{account.emailVerified ? `${account.creditsAvailable ?? 0} search credit${account.creditsAvailable === 1 ? '' : 's'} available` : 'Email not verified. The free search has not been granted.'}</p>
        <p className="auth-plan">{account.plan?.name ?? 'Free'} · server enforced</p>
        {!account.emailVerified && (
          <label className="auth-token">Verification token
            <input value={token} onChange={(event) => setToken(event.target.value)} aria-label="Verification token" />
          </label>
        )}
        <div className="auth-actions">
          {!account.emailVerified && <button type="button" onClick={verify} disabled={busy || token.length < 32}>Verify email</button>}
          {!account.emailVerified && <button type="button" onClick={resend} disabled={busy}>Resend code</button>}
          <button type="button" onClick={logout}>Sign out</button>
        </div>
        {message && <p className={error ? 'auth-error' : 'auth-note'}>{message}</p>}
      </div>
    );
  }

  return (
    <form className="auth-panel" onSubmit={submit}>
      <span className="eyebrow">ACCOUNT</span>
      <strong>{mode === 'register' ? 'Create a verified account.' : 'Sign in.'}</strong>
      <p>The first verified account gets one Trend Search. The allowance lives on the server, not in this browser.</p>
      <div className="auth-switch" role="group" aria-label="Account mode">
        <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Create</button>
        <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Sign in</button>
      </div>
      <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? 'Working…' : mode === 'register' ? 'Create account' : 'Sign in'} <ArrowRight size={15} /></button>
      <p className="auth-mail"><ShieldCheck size={13} /> Verify your email to receive your free search. Local development provides a verification code in this session.</p>
      {token && <label className="auth-token">Verification token<input value={token} onChange={(event) => setToken(event.target.value)} aria-label="Verification token" /></label>}
      {token && <button type="button" onClick={verify} disabled={busy}>Verify this account</button>}
      {message && <p className={error ? 'auth-error' : 'auth-note'} role={error ? 'alert' : 'status'}>{message}</p>}
    </form>
  );
}
