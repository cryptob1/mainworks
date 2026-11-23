import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineCommands } from './registry.js';
import { realRuntimeBinary } from '../runtime-binary.js';

/**
 * GY-3530: one throwaway read-only investigator. The item's head is exported (git archive, no
 * link back to the repository) into a read-only temporary folder; one headless run answers the
 * question there with read tools only, under a time bound, holding no lease. Its answer — or one
 * plain failure line — is recorded on the item's history, where the next attempt finds it.
 */
const readOnlyArgs: Record<string, (request: string) => string[]> = {
  claude: request => ['-p', '--output-format', 'text', '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task', request],
  codex: request => ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', request],
};
const answerSchema = z.object({ summary: z.string().trim().min(1), evidence: z.array(z.string().regex(/^\S+:\d+/, 'each entry is file:line')) });
type Note = { summary: string; evidence: string[] } | { failure: string };

function investigate(program: string, args: string[], cwd: string, boundSeconds: number): Promise<{ stdout: string; failure?: string }> {
  return new Promise(resolve => {
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-256 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, boundSeconds * 1000);
    child.on('error', error => { clearTimeout(timer); resolve({ stdout, failure: `The investigator could not start: ${error.message}.` }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return resolve({ stdout, failure: `The investigator ran past its ${boundSeconds}-second bound and was stopped.` });
      const said = stderr.trim().split('\n').at(-1)?.trim();
      resolve(code === 0 ? { stdout } : { stdout, failure: `The investigator exited with code ${code}${said ? `: ${said}` : ''}.` });
    });
  });
}

export const askCommands = defineCommands([{
  name: 'ask',
  scope: 'work',
  help: ['  ask GY-N QUESTION            One read-only investigator answers on the item head; the answer is noted on the item'],
  async run({ args, api, print }, work) {
    const question = args.join(' ').trim();
    if (!question) throw new Error('Use ask GY-N QUESTION');
    const head: string = work.candidate?.sha ?? work.workspaces?.at(-1)?.branch ?? 'HEAD';
    const kind = process.env.GRAPHYARD_ASK_RUNTIME ?? 'claude', bound = Number(process.env.GRAPHYARD_ASK_TIMEOUT_SECONDS ?? 600);
    if (!readOnlyArgs[kind]) throw new Error(`GRAPHYARD_ASK_RUNTIME must be one of ${Object.keys(readOnlyArgs).join(', ')}`);
    const request = `You are a read-only investigator on a copy of ${work.key} (${work.title}) at ${head}. Read the files here to answer one question; change nothing. Question: ${question}\nEnd with one JSON object: {"summary": "the plain answer in at most five sentences", "evidence": ["path/file.ts:LINE"]}.`;
    const checkout = mkdtempSync(join(tmpdir(), 'graphyard-ask-'));
    let note: Note;
    try {
      execFileSync('tar', ['-x', '-C', checkout], { input: execFileSync('git', ['archive', head], { maxBuffer: 1 << 30 }) });
      execFileSync('chmod', ['-R', 'a-w', checkout]);
      const run = await investigate(realRuntimeBinary(kind), readOnlyArgs[kind]!(request), checkout, bound);
      if (run.failure) note = { failure: run.failure };
      else {
        const { jsonAnswer } = await import('../headless-session.js');
        try { note = jsonAnswer(run.stdout, answerSchema); } catch (error) { note = { failure: `The investigator's answer could not be read: ${(error as Error).message}.` }; }
      }
    } finally {
      execFileSync('chmod', ['-R', 'u+w', checkout]);
      rmSync(checkout, { recursive: true, force: true });
    }
    return print(await api(`work/${encodeURIComponent(work.id)}/note`, { question, head, ...note }));
  },
}]);
