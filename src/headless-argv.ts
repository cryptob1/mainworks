import { launchRecipe, requestPlaceholder, type RegisteredLaunch } from './harness.js';
import { realRuntimeBinary } from './runtime-binary.js';
import { acceptedFlags, runtimeAdapter } from './master/runtimes.js';

/**
 * How each runtime takes one request and exits: a subcommand before its own flags, the flags that
 * select print mode after them, and flags its one-shot form does not accept. The request is the
 * last argument, or takes a registry contract's `{request}` place. A runtime without a built-in form requires a registry headless contract.
 */
export const headlessKind = (kind: string | undefined, contract?: RegisteredLaunch | null): kind is string => !!kind && (!!runtimeAdapter(kind)?.headless || !!contract?.headlessArgs);
export class HeadlessConfigurationError extends Error {}
/** GY-3632: whether a run of `kind` can continue an earlier runtime session: its built-in form names a continue form. */
export const continuable = (kind: string | null | undefined, contract?: RegisteredLaunch | null) => !contract?.headlessArgs && !!runtimeAdapter(kind)?.continue;

/**
 * GY-3696, GY-3713: Linux caps a single argv string at MAX_ARG_STRLEN (128 KiB); a headless prompt
 * past this bound goes on stdin instead of as a command-line argument so spawn never fails with
 * E2BIG, on agy and on every built-in form that names its stdin words, while smaller prompts stay on argv.
 */
export const inlinePromptLimitBytes = 64 * 1024;
const agyPrintFlags = new Set(['-p', '--print', '--prompt']);
const stdinForm = (kind: string, contract?: RegisteredLaunch | null) => contract?.headlessArgs ? undefined : runtimeAdapter(kind)?.headless?.stdin;
/** The prompt to pipe to stdin for a headless run, or undefined when the prompt stays on argv. */
export const headlessPromptInput = (kind: string, prompt: string, contract?: RegisteredLaunch | null): string | undefined =>
  (kind === 'agy' || stdinForm(kind, contract)) && Buffer.byteLength(prompt, 'utf8') > inlinePromptLimitBytes ? prompt : undefined;

/**
 * Explicit argv replaces the interactive argv and built-in form. A leading subcommand precedes policy flags.
 * Of the form's optional flags, only `accepted` ones are passed, once each, whether the form or the profile names them (GY-3425).
 */
export function headlessArgs(kind: string, args: readonly string[], prompt: string, contract?: RegisteredLaunch | null, accepted: readonly string[] = [], session?: string | null): string[] {
  if (session && !continuable(kind, contract)) throw new HeadlessConfigurationError(`The ${kind} runtime has no continue form`);
  const onStdin = headlessPromptInput(kind, prompt, contract) !== undefined;
  const place = (arg: string, index: number, list: readonly string[]) => {
    if (arg === requestPlaceholder) return onStdin ? [] : [prompt];
    if (onStdin && agyPrintFlags.has(arg) && list[index + 1] === requestPlaceholder) return [];
    return [arg];
  };
  if (contract?.headlessArgs) {
    const words = contract.headlessArgs;
    if (words.filter(word => word === requestPlaceholder).length !== 1) throw new HeadlessConfigurationError(`${kind}: launch.headlessArgs must contain exactly one {request}`);
    const subcommand = words[0] !== requestPlaceholder && !words[0]?.startsWith('-') ? 1 : 0;
    return [...words.slice(0, subcommand), ...args.filter(arg => arg !== requestPlaceholder), ...words.slice(subcommand).flatMap(place)];
  }
  const form = runtimeAdapter(kind)?.headless;
  if (!form) throw new HeadlessConfigurationError(`The ${kind} runtime has no one-task contract. Set launch.headlessArgs with exactly one {request} using mainworks master registry runtime set NAME --headless-arg=ARG --reason REASON; reviews never use Herdr.`);
  const drop = form.drop ?? [], optional = form.optional ?? [];
  const kept = args.filter((arg, index) => !drop.some(flag => arg === flag || arg.startsWith(`${flag}=`) || args[index - 1] === flag) && !optional.includes(arg));
  const placed = kept.includes(requestPlaceholder);
  const resumed = session ? runtimeAdapter(kind)!.continue!(session) : [];
  return [...form.before, ...kept.flatMap(place), ...form.flags, ...optional.filter(flag => accepted.includes(flag)), ...resumed, ...(onStdin ? form.stdin ?? [] : placed ? [] : [prompt])];
}

/** The headless command line of one run: the installed runtime, asked once which of its form's optional flags it takes. */
export async function headlessArgv(launch: { kind: string; args: readonly string[]; contract?: RegisteredLaunch | null; session?: string | null }, request: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const form = runtimeAdapter(launch.kind)?.headless;
  const program = realRuntimeBinary(form?.program ?? (launchRecipe(launch.kind)?.program ?? launch.kind), env);
  const accepted = launch.contract?.headlessArgs || !form ? [] : await acceptedFlags(program, form.before, form.optional ?? [], env);
  return [program, ...headlessArgs(launch.kind, launch.args, request, launch.contract, accepted, launch.session)];
}
