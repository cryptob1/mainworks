import { useEffect, useState } from 'react';
import type { Dashboard } from './dashboard';

interface Person { id: string; name: string }
interface SlackView {
  manifest: unknown;
  tokens: { team: string; bot: string; channels: Person[]; people: Person[] } | null;
  waiting: boolean;
  loop: { connected: boolean; channel: string | null; channelName: string | null; lastMessageAt: string | null; at: string } | null;
}

const minutesAgo = (at: string, now: number) => Math.max(0, Math.round((now - Date.parse(at)) / 60_000));

/** One numbered step with its done or not-done mark. */
function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return <li className="panel slack-step" aria-label={title} data-done={done ? 'yes' : 'no'}>
    <h3>{n}. {title} <span className={done ? 'green' : 'muted'}>{done ? 'Done' : 'Not done'}</span></h3>
    {children}
  </li>;
}

/**
 * GY-4073: Settings › Slack walks the owner through connecting the factory's Slack app: create it from
 * the manifest, paste its two tokens, pick the channel and the people, then see it connected.
 */
export function SlackPage({ api, observedAt }: Pick<Dashboard, 'api' | 'observedAt'>) {
  const [view, setView] = useState<SlackView | null>(null);
  const [line, setLine] = useState<{ text: string; ok: boolean } | null>(null);
  const [appToken, setAppToken] = useState(''), [botToken, setBotToken] = useState('');
  const [channel, setChannel] = useState(''), [owner, setOwner] = useState(''), [people, setPeople] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const load = () => api('slack').then(setView, (error: Error) => setLine({ text: error.message, ok: false }));
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 5_000); return () => clearInterval(timer); }, [api]);
  const act = (path: string, body: unknown, ok: (next: SlackView) => string) => api(path, body).then((next: SlackView) => { setView(next); setLine({ text: ok(next), ok: true }); }, (error: Error) => setLine({ text: error.message, ok: false }));
  const connect = () => act('slack/connect', { appToken, botToken }, next => { setAppToken(''); setBotToken(''); return `Connected to ${next.tokens!.team} as @${next.tokens!.bot}.`; });
  const save = () => act('slack/channel', { channel, owner, people }, () => 'Saved. The loop connects within a minute.');
  if (!view) return <section className="panel" aria-label="Slack"><h2>Slack</h2><p>{line?.text ?? 'Loading…'}</p></section>;
  const connected = !!view.loop?.connected && !view.waiting;
  const tokensDone = !!view.tokens || connected;
  const channels = view.tokens?.channels ?? [];
  return <section aria-label="Slack" className="slack-page">
    <h2>Slack</h2>
    <p>Let people talk to the Lead from one Slack channel. The factory dials out to Slack; nothing on your network opens.</p>
    {line && <p role={line.ok ? 'status' : 'alert'} aria-label="Slack result" className={line.ok ? 'green' : 'amber'}>{line.text}</p>}
    <ol className="slack-steps">
      <Step n={1} title="Create the Slack app" done={tokensDone}>
        <p>Open <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">api.slack.com/apps</a>, choose From a manifest, pick your workspace and paste the manifest. It turns Socket Mode on.</p>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(view.manifest, null, 2)).then(() => setCopied(true), () => setCopied(false))}>{copied ? 'Manifest copied' : 'Copy manifest'}</button>
      </Step>
      <Step n={2} title="Paste the two tokens" done={tokensDone}>
        <form onSubmit={event => { event.preventDefault(); void connect(); }}>
          <label>App-level token: starts with xapp-. Basic Information › App-Level Tokens › Generate, with the connections:write scope.
            <input type="password" autoComplete="off" value={appToken} onChange={event => setAppToken(event.target.value)}/></label>
          <label>Bot token: starts with xoxb-. Install App › Install to workspace, then copy the Bot User OAuth Token.
            <input type="password" autoComplete="off" value={botToken} onChange={event => setBotToken(event.target.value)}/></label>
          <button type="submit" disabled={!appToken.trim() || !botToken.trim()}>Connect</button>
        </form>
      </Step>
      <Step n={3} title="Pick the channel" done={connected || view.waiting}>
        {!view.tokens ? <p className="muted">Connect the tokens first.</p>
          : channels.length ? <label>Channel
            <select value={channel} onChange={event => setChannel(event.target.value)}><option value="">Choose a channel</option>{channels.map(entry => <option key={entry.id} value={entry.id}>#{entry.name}</option>)}</select></label>
          : <p>The app is in no channel yet. In Slack, type /invite @{view.tokens.bot} in the channel, then press Connect again.</p>}
      </Step>
      <Step n={4} title="Choose who may talk to the Lead" done={connected || view.waiting}>
        {!view.tokens ? <p className="muted">Connect the tokens first.</p> : <>
          <label>You, the owner
            <select value={owner} onChange={event => setOwner(event.target.value)}><option value="">Choose yourself</option>{view.tokens.people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          <fieldset><legend>Also allowed</legend>
            {view.tokens.people.filter(person => person.id !== owner).map(person => <label key={person.id} className="inline"><input type="checkbox" checked={people.includes(person.id)} onChange={event => setPeople(event.target.checked ? [...people, person.id] : people.filter(id => id !== person.id))}/> {person.name}</label>)}
          </fieldset>
          <button type="button" disabled={!channel || !owner} onClick={() => void save()}>Save and connect</button>
        </>}
      </Step>
      <Step n={5} title="Connected" done={connected}>
        {connected
          ? <p role="status" aria-label="Slack status"><strong>Connected to #{view.loop!.channelName ?? view.loop!.channel}</strong>{view.loop!.lastMessageAt ? `, last message ${minutesAgo(view.loop!.lastMessageAt, now)} min ago` : ', no message yet'}. <button type="button" onClick={() => void act('slack/disconnect', {}, () => 'Disconnected. The loop removes the tokens within a minute.')}>Disconnect</button></p>
          : <p role="status" aria-label="Slack status">{view.waiting ? 'Waiting for the loop to connect…' : 'Not connected.'}</p>}
      </Step>
    </ol>
  </section>;
}
