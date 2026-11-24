// GY-3716: a docs sign-off judges the documentation a candidate changes, so it stands for a later
// head of the same item while those files are byte-identical. Every other manual proof binds the head.
import type { ScopeFile } from './work.js';

/** A proof whose attestation judges the candidate's documentation: `manual:docs-updated/…`. */
export const docsSignoffProof = (proof: string) => proof.startsWith('manual:docs-updated/');
/** The documentation files: README.md, docs/**, the Guide page and the glossary source. */
const documentationFile = (path: string) => path === 'README.md' || path.startsWith('docs/') || path === 'web/pages/guide.tsx' || path === 'web/glossary.ts';
/** What the digest of a candidate's documentation is taken over: each changed doc file with its blob, sorted. */
export const documentationDigestInput = (files: readonly Pick<ScopeFile, 'path' | 'sha'>[]) =>
  files.filter(file => documentationFile(file.path)).map(file => `${file.path}\t${file.sha ?? 'removed'}`).sort().join('\n');
