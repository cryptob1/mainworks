import { defineCommands } from './registry.js';

export const upgradeCommands = defineCommands([{
  name: 'upgrade',
  help: [
    '  upgrade [--to VERSION] [--plan]',
    '                                Back up the database, move the CLI checkout (then npm ci),',
    '                                redeploy the server, restart loop and executors, refresh the',
    '                                generated files, and check /healthz, to Mainworks\' main tip',
    '                                (or the dated release VERSION);',
    '                                --plan prints the steps only; a failure names its step and rollback',
    '  upgrade --repair-identity     Restore a moved CLI release’s local commit stamp.',
    '  upgrade --watch [--once] [--checkout DIR]',
    '                                The deploy unit (graphyard-deploy.service): fetch origin and, for',
    '                                each new base tip, build, restart, check /healthz, and roll back',
    '                                to the previous tip on failure; the watch then restarts on the',
    '                                code it served; DIR is the install\'s own checkout.',
    '                                An install for another repository upgrades its own control plane',
    '                                by itself: each pass (at least daily) checks the commit Mainworks\'',
    '                                batch gate verified, as refs/graphyard/verified on Mainworks\'',
    '                                canonical upstream — never an unverified main tip — and runs the',
    '                                upgrade steps to exactly that commit, keeping its state in',
    '                                .graphyard/control-plane.json (commit, last check, last update,',
    '                                last failed step); a failed upgrade keeps the previous version and',
    '                                retries; see `mainworks guide upgrade`',
  ],
  async run(context) {
    return (await import('./upgrade.js')).runUpgradeCommand(context);
  },
}]);
