import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProductBrief } from '../../src/model/project-memory';
import { EmptyState, PageHeader } from '../components/page-layout';

/** The dashboard's Product page (GY-3274): the install's one product brief, shown read-only. */
export default function ProductPage({ api }: { api: (path: string) => Promise<any> }) {
  const [brief, setBrief] = useState<ProductBrief | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const load = async () => {
    const version = ++request.current; setLoading(true); setError('');
    try { const next = await api('product-brief'); if (version === request.current) setBrief(next.brief ?? null); }
    catch (e) { if (version === request.current) setError((e as Error).message); }
    finally { if (version === request.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { request.current++; }; }, []);
  return <ProductView brief={brief} error={error} loading={loading} retry={() => void load()}/>;
}

/** The page as rendered from one read, so it can be drawn and tested without the network. */
export function ProductView({ brief, error, loading, retry }: { brief: ProductBrief | null; error: string; loading: boolean; retry(): void }) {
  const when = (at: string) => new Date(at).toLocaleString();
  return <section className="product-page" aria-label="Product">
    <PageHeader title="Product" fact={brief ? `Updated ${new Date(brief.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} by the master.` : loading ? 'Reading the product brief…' : error ? 'The product brief could not be read.' : 'No product brief yet.'}
      actions={error && <button type="button" onClick={retry}>Retry</button>}/>
    {error && <p role="alert" className="amber">{error}</p>}
    {!loading && !error && !brief && <EmptyState title="The master has not written the brief.">It records one with <code>master brief set FILE REASON</code>.</EmptyState>}
    {brief && <article className="product-brief panel">{briefBlocks(brief.markdown)}</article>}
    {brief && brief.history.length > 0 && <details className="panel product-history"><summary>Changes ({brief.history.length})</summary><ul>
      {brief.history.map(change => <li key={`${change.at}:${change.by}`}>{when(change.at)} — {change.by}: {change.why} ({change.words} words)</li>)}
    </ul></details>}
  </section>;
}

/** The brief's Markdown as headings, bullet lists and paragraphs (GY-3560): the master's own text, never HTML. */
function briefBlocks(markdown: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  let list: string[] = [], text: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((item, index) => <li key={index}>{item}</li>)}</ul>);
    if (text.length) blocks.push(<p key={blocks.length}>{text.join(' ')}</p>);
    list = []; text = [];
  };
  for (const line of markdown.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line), item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) { if (text.length) flush(); list.push(item[1]); }
    else if (heading) { flush(); blocks.push(heading[1].length <= 2 ? <h2 key={blocks.length}>{heading[2]}</h2> : <h3 key={blocks.length}>{heading[2]}</h3>); }
    else if (line.trim()) { if (list.length) flush(); text.push(line.trim()); }
    else flush();
  }
  flush();
  return blocks;
}
