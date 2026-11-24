import { defineCommands } from './registry.js';

/** GY-3407: lend a spare machine's compute, nothing else; merge trials send it test shards (GY-3412). */
export const hostCommands = defineCommands([{
  name: 'host',
  help: [
    '  host prepare                  Print the one-time sudo script for a host: an unprivileged gy-compute user',
    '                                with rootless Docker, whose key may only run graphyard-host-shim',
    '  host add USER@HOST[:PORT]     Check the host answers only through the shim, as neither root nor the',
    '  host add ALIAS                docker group, and record it; Workers lists it (away when unreachable).',
    '                                Warns when your own account logs into it unattended on port 22',
    '  host sessions USER@HOST N     Let the host run N agent sessions at once (0: test shards only).',
    '                                Codex workers start there; each login is handed over per session',
    '                                in memory and never written to the host\'s disk',
    '  host remove USER@HOST         Stop reading the host',
    '  host list                     The recorded hosts',
  ],
  readsConnection: () => false,
  async run(context) {
    const [{ addHost, hostPrepareScript, localPublicKey, readHosts, removeHost, sessionHelperProblem, setHostSessions }, { runRemoteSession }] = await Promise.all([
      import('../hosts.js'), import('../remote-session.js'),
    ]);
    const [target] = context.args;
    if (context.id === 'prepare') {
      process.stdout.write(hostPrepareScript(await localPublicKey()));
    } else if (context.id === 'add' && target) {
      const result = await addHost(target);
      console.log(result.added ? `Added ${target}: ${result.probe?.cores ?? '?'} cores, rootless Docker answers through the shim. Workers lists it from the loop's next cycle, and merge trials send it test shards.` : `${target} is already added.`);
      const operator = result.added ? result.operator : null;
      if (operator) console.log(operator.unattended
        ? `Warning: ${operator.login} logs in unattended on port 22, so anything running as you here can open a shell there. If it is Tailscale SSH, set every ssh rule reaching that host to action check in your tailnet policy.`
        : `Tailnet check: ${operator.login} does not log in unattended on port 22.`);
    } else if (context.id === 'sessions' && target && context.args[1] !== undefined) {
      await setHostSessions(target, Number(context.args[1]));
      console.log(Number(context.args[1]) ? `${target} takes up to ${Number(context.args[1])} agent sessions at once from the loop's next dispatch.` : `${target} takes test shards only.`);
    } else if (context.id === 'session' && target) {
      // The worker launcher's own form under watch: host session TARGET [--home DIR]… [--env NAME]… [--confine JSON] --cli PATH -- RUNTIME ARGS…
      const separator = context.args.indexOf('--'), flags = context.args.slice(1, separator);
      const values = (flag: string) => flags.flatMap((word, index) => word === flag && flags[index + 1] ? [flags[index + 1]!] : []);
      const cli = values('--cli')[0];
      if (separator < 0 || !cli || !context.args[separator + 1]) throw new Error('Usage: mainworks host session USER@HOST [--home DIR]... [--env NAME]... --cli PATH -- COMMAND ARGS');
      const env = Object.fromEntries(values('--env').flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
      const confine = values('--confine')[0];
      process.exitCode = await runRemoteSession({ target, worktree: process.cwd(), homes: values('--home'), cli, argv: context.args.slice(separator + 1), env, confine: confine ? JSON.parse(confine) as string[] : [] });
    } else if (context.id === 'remove' && target) {
      console.log((await removeHost(target)).removed ? `Removed ${target}.` : `${target} was not added.`);
    } else if (context.id === 'list' || !context.id) {
      const hosts = await readHosts();
      const lines = await Promise.all(hosts.map(async host => {
        const problem = host.sessions ? await sessionHelperProblem(host.target) : null;
        return `${host.target}  added ${host.addedAt}${host.sessions ? (problem ? `, set to ${host.sessions} sessions but takes none: ${problem}` : `, takes ${host.sessions} sessions`) : ''}`;
      }));
      console.log(hosts.length ? lines.join('\n') : 'No host added: this machine runs all work. Prepare one with mainworks host prepare, then mainworks host add gy-compute@HOST.');
    } else throw new Error('Usage: mainworks host prepare | host add USER@HOST[:PORT] | host add ALIAS | host sessions USER@HOST N | host remove USER@HOST | host list');
  },
}]);
