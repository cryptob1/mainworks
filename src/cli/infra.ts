import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defineCommands, type CliCommand } from './registry.js';
import type { CliContext } from './context.js';
import { stateDirectory } from '../install/layout.js';

/**
 * GY-3515: scoped infra access. The owner approves one repository and one hosting project; the
 * confined master takes a credential limited to them, kept in the checkout's ignored .graphyard
 * (mode 0600, never printed), and creates and pushes the repository and creates the hosting project
 * and its environments through the control plane, which records each call.
 */
const usage = 'Usage: mainworks infra approve OWNER/NAME --project NAME [--from OLD] | take | repo create OWNER/NAME | repo push OWNER/NAME [DIR] | project create NAME | env create PROJECT ENV | log';
const infraCredentialFile = (root: string) => join(stateDirectory(root), 'infra-credential');

async function act(context: CliContext, body: Record<string, unknown>) {
  let token: string;
  try { token = JSON.parse(await readFile(infraCredentialFile(context.repositoryRoot()), 'utf8')).token; } catch { throw new Error('No infra credential here: run mainworks infra take once the owner approves the task.'); }
  const response = await fetch(`${context.base.replace(/\/+$/, '')}/api/infra/act`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await response.json() as { error?: string };
  if (!response.ok) throw new Error(answer.error ?? `The control plane answered ${response.status}`);
  return answer;
}

export const infraCommands = defineCommands([{
  name: 'infra',
  help: ['  infra approve OWNER/NAME --project NAME [--from OLD]  The owner approves one repository and one hosting project',
    '  infra take                    The lead takes a credential limited to the approved names',
    '  infra repo create|push OWNER/NAME [DIR] · infra project create NAME · infra env create PROJECT ENV · infra log'],
  async run(context) {
    const { values, positionals } = parseArgs({ args: [context.id ?? '', ...context.args].filter(Boolean), allowPositionals: true, options: { project: { type: 'string' }, from: { type: 'string' } } });
    const [verb, noun, a, b] = positionals;
    if (verb === 'approve' && noun && values.project) {
      const { asRecordedOperator } = await import('./session-commands.js');
      await asRecordedOperator(context.repositoryRoot());
      return context.print(await context.api('infra/approvals', { repository: noun, project: values.project, ...(values.from ? { from: values.from } : {}) }));
    }
    if (verb === 'take') {
      const { token, repository, project } = await context.api('infra/credential', {}) as { token: string; repository: string; project: string };
      const file = infraCredentialFile(context.repositoryRoot());
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, JSON.stringify({ token, repository, project }), { mode: 0o600 });
      return context.print({ repository, project, next: `Create it: mainworks infra repo create ${repository}` });
    }
    if (verb === 'log') return context.print(await context.api('infra/actions'));
    if (verb === 'repo' && noun === 'create' && a) return context.print(await act(context, { action: 'repo.create', repository: a }));
    if (verb === 'repo' && noun === 'push' && a) {
      const bundle = execFileSync('git', ['-C', resolve(b ?? '.'), 'bundle', 'create', '-', '--branches', '--tags'], { maxBuffer: 140_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
      return context.print(await act(context, { action: 'repo.push', repository: a, bundle: bundle.toString('base64') }));
    }
    if (verb === 'project' && noun === 'create' && a) return context.print(await act(context, { action: 'project.create', project: a }));
    if (verb === 'env' && noun === 'create' && a && b) return context.print(await act(context, { action: 'environment.create', project: a, environment: b }));
    throw new Error(usage);
  },
} satisfies CliCommand]);
