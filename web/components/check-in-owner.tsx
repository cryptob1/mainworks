import { useState, type FormEvent } from 'react';
import type { Dashboard } from '../pages/dashboard';

type Owner = { name: string; email: string };

/** GY-3850: who every commit is authored by — the owner's name and email, as 'NAME (Mainworks)'. GY-3995: the owner names or changes it here. */
export function CheckInOwner({ api, status }: Pick<Dashboard, 'api' | 'status'>) {
  const [saved, setSaved] = useState<Owner | null>(null);
  const [error, setError] = useState('');
  const owner = saved ?? status?.owner as Owner | null | undefined;
  const canEdit = status?.actor?.role === 'admin';
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void api('owner', { name: String(form.get('name') ?? ''), email: String(form.get('email') ?? '') })
      .then((answer: { owner: Owner }) => { setSaved(answer.owner); setError(''); }, (e: Error) => setError(e.message));
  };
  const form = <form className="grant-form" aria-label="Name the owner" onSubmit={submit}>
    <label>Name<input name="name" required defaultValue={owner?.name}/></label>
    <label>Email<input name="email" type="email" required defaultValue={owner?.email}/></label>
    <button type="submit">{owner ? 'Save' : 'Name the owner'}</button>
    {error && <p role="alert" className="amber">{error}</p>}
  </form>;
  return <section className="panel" aria-label="Identity" data-check-in-owner>
    <h2>Identity</h2>
    {owner ? <>
      <p>Owner: <strong data-owner-name>{owner.name}</strong> · <span data-owner-email>{owner.email}</span></p>
      <p className="muted">Commits are authored {owner.name} (Mainworks).</p>
      {canEdit && <details className="more-details"><summary>Change owner</summary>{form}</details>}
    </> : <>
      <p className="amber">Commits are authored Mainworks{canEdit ? ': name the owner below.' : ' until the owner names themselves.'}</p>
      {canEdit && form}
    </>}
  </section>;
}
