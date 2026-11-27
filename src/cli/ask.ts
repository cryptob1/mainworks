import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { defineCommands } from './registry.js';
import { setting } from '../setting.js';

/**
 * GY-3530: one throwaway read-only investigator. The item's head is exported (git archive, no
 * link back to the repository) into a read-only temporary folder; one headless run answers the
 * question there with read tools only, under a time bound, holding no lease. Its answer — or one
 * plain failure line — is recorded on the item's history, where the next attempt finds it.
 * GY-3898: the request goes on stdin, as headless sessions take large prompts (GY-3713); a trailing
 * argument after Claude's variadic tool lists was read as one more tool, leaving no prompt.
 * GY-4033: resolve the investigator's runtime the way worker launches do — from the control-plane
 * registry's account, program path and environment — rather than spawning a bare `claude` on the
 * caller's PATH; when no runtime can start, name every runtime tried and why each failed.
 */
const readOnlyArgs: Record<string, string[]> = {
  claude: ['-p', '--output-format', 'text', '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task'],
  codex: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
};
const defaultHomeVariable: Record<string, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

interface InvestigatorCandidate {
  account: string | null;
  runtime: string;
  kind: string;
  home: string | null;
  homeVariable: string | null;
  environment: Record<string, string>;
}

type Note = { summary: string; evidence: string[] } | { failure: string };

function investigatorEnvironment(candidate: InvestigatorCandidate, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const basePath = baseEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const runtimePath = candidate.environment.PATH;
  const mergedPath = runtimePath
    ? [...new Set([...runtimePath.split(delimiter), ...basePath.split(delimiter)].filter(Boolean))].join(delimiter)
    : basePath;
  const env: NodeJS.ProcessEnv = { ...baseEnv, MISE_NO_CONFIG: '1', ...candidate.environment, PATH: mergedPath };
  const homeVariable = candidate.homeVariable ?? defaultHomeVariable[candidate.kind] ?? null;
  if (homeVariable && candidate.home) env[homeVariable] = candidate.home;
  return env;
}

function investigate(program: string, args: string[], request: string, cwd: string, boundSeconds: number, env: NodeJS.ProcessEnv): Promise<{ stdout: string; failure?: string; startFailure?: string }> {
  return new Promise(resolve => {
    const child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdin.on('error', () => {});
    child.stdin.end(request);
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-256 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, boundSeconds * 1000);
    child.on('error', error => { clearTimeout(timer); resolve({ stdout, startFailure: error.message }); });
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
  async run({ args, api, print, individualHostId }, work) {
    const question = args.join(' ').trim();
    if (!question) throw new Error('Use ask GY-N QUESTION');
    const head: string = work.candidate?.sha ?? work.workspaces?.at(-1)?.branch ?? 'HEAD';
    const explicitKind = setting('ASK_RUNTIME'), bound = Number(setting('ASK_TIMEOUT_SECONDS') ?? 600);
    if (explicitKind && !readOnlyArgs[explicitKind]) throw new Error(`GRAPHYARD_ASK_RUNTIME must be one of ${Object.keys(readOnlyArgs).join(', ')}`);
    const host = individualHostId();
    const registered: InvestigatorCandidate[] = await api(`agent-registry/investigator?host=${encodeURIComponent(host)}`)
      .then((body: any) => Array.isArray(body?.candidates) ? body.candidates : [])
      .catch(() => []);
    const matching = registered.filter(candidate => candidate.kind in readOnlyArgs && (!explicitKind || candidate.kind === explicitKind));
    const candidates: InvestigatorCandidate[] = matching.length
      ? matching
      : (explicitKind ? [explicitKind] : Object.keys(readOnlyArgs)).map(kind => ({ account: null, runtime: kind, kind, home: null, homeVariable: null, environment: {} }));
    const request = `You are a read-only investigator on a copy of ${work.key} (${work.title}) at ${head}. Read the files here to answer one question; change nothing. Question: ${question}\nEnd with one JSON object: {"summary": "the plain answer in at most five sentences", "evidence": ["path/file.ts:LINE"]}.`;
    const checkout = mkdtempSync(join(tmpdir(), 'mainworks-ask-'));
    let note: Note;
    try {
      execFileSync('tar', ['-x', '-C', checkout], { input: execFileSync('git', ['archive', head], { maxBuffer: 1 << 30 }) });
      execFileSync('chmod', ['-R', 'a-w', checkout]);
      const { onSearchPath, realRuntimeBinary } = await import('../runtime-binary.js');
      const startFailures: string[] = [];
      let run: { stdout: string; failure?: string } | null = null;
      for (const candidate of candidates) {
        const label = candidate.account ? `${candidate.runtime} (account ${candidate.account})` : candidate.runtime;
        const env = investigatorEnvironment(candidate);
        const real = realRuntimeBinary(candidate.kind, env);
        const program = onSearchPath(real, env.PATH);
        if (!program) {
          startFailures.push(`${label}: ${real} not found on PATH`);
          continue;
        }
        const attempt = await investigate(program, readOnlyArgs[candidate.kind]!, request, checkout, bound, env);
        if (attempt.startFailure) {
          startFailures.push(`${label}: ${attempt.startFailure}`);
          continue;
        }
        run = attempt;
        break;
      }
      if (!run) note = { failure: `The investigator could not start: tried ${startFailures.join('; ')}.` };
      else if (run.failure) note = { failure: run.failure };
      else {
        const [{ z }, { jsonAnswer }] = await Promise.all([import('zod'), import('../headless-session.js')]);
        const answerSchema = z.object({ summary: z.string().trim().min(1), evidence: z.array(z.string().regex(/^\S+:\d+/, 'each entry is file:line')) });
        try { note = jsonAnswer(run.stdout, answerSchema); } catch (error) { note = { failure: `The investigator's answer could not be read: ${(error as Error).message}.` }; }
      }
    } finally {
      execFileSync('chmod', ['-R', 'u+w', checkout]);
      rmSync(checkout, { recursive: true, force: true });
    }
    return print(await api(`work/${encodeURIComponent(work.id)}/note`, { question, head, ...note }));
  },
}]);
