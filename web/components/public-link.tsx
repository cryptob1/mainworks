import { useEffect, useState } from 'react';
import type { Dashboard } from '../pages/dashboard';

type Setting = { on: boolean; by: string | null; at: string | null };

/**
 * GY-3690: Settings shows whether this install's public link is on. Off by default; only the owner's
 * human session turns it on, and only then does the loop run Tailscale Funnel for this install.
 */
export function PublicLink({ api, status }: Pick<Dashboard, 'api' | 'status'>) {
  const [setting, setSetting] = useState<Setting | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void api('team-access/public-link').then(setSetting, (e: Error) => setError(e.message)); }, [api]);
  const owner = status?.actor?.role === 'admin' && status.actor.sessionKind === 'human';
  const change = (on: boolean) => api('team-access/public-link', { on }).then((next: Setting) => { setSetting(next); setError(''); }, (e: Error) => setError(e.message));
  return <section className="panel" aria-label="Public link">
    <h2>Public link</h2>
    {!setting ? <p>{error || 'Loading…'}</p> : <>
      <p data-public-link={setting.on ? 'on' : 'off'}><strong>{setting.on ? 'On' : 'Off'}</strong>: {setting.on ? 'invited people open the dashboard from any device.' : 'the dashboard opens only on your tailnet.'}</p>
      {setting.by && <p className="muted">Set by {setting.by} on {new Date(setting.at!).toLocaleString()}</p>}
      {owner && <button type="button" onClick={() => void change(!setting.on)}>{setting.on ? 'Turn off' : 'Turn on'}</button>}
      {error && <p role="alert" className="amber">{error}</p>}
    </>}
  </section>;
}
