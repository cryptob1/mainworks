import type { Dashboard } from '../pages/dashboard';

/** GY-3850: who every commit is authored by — the owner's name and email, as 'NAME (Mainworks)'. */
export function CheckInOwner({ status }: Pick<Dashboard, 'status'>) {
  const owner = status?.owner as { name: string; email: string } | null | undefined;
  return <section className="panel" aria-label="Identity" data-check-in-owner>
    <h2>Identity</h2>
    {owner ? <>
      <p>Owner: <strong data-owner-name>{owner.name}</strong> · <span data-owner-email>{owner.email}</span></p>
      <p className="muted">Commits are authored {owner.name} (Mainworks).</p>
    </> : <p className="amber">Commits are authored Mainworks. Run mainworks config owner "NAME" EMAIL to name the owner.</p>}
  </section>;
}
