import { defineCommands } from './registry.js';
import { sessionCommands } from './session-commands.js';
import { inviteCommand } from './invite.js';
import { configCommand } from './config-owner.js';
import { registryHelp } from './master-registry-help.js';
import { closeHelp } from './master-close.js';

/** Every master subcommand authenticates with the coordinator credential the master keeps for itself, never the repository connection file. */
export const masterCommands = defineCommands([
  {
    name: 'master',
    readsConnection: () => false,
    help: [
      '  master init --token-stdin [--herdr-workspace ID]',
      '              [--dispatch-interval SECONDS] [--reviewer-profile NAME] [--producer-timeout MINUTES]',
      '              [--replace-supervisor] Install the operating mode and, in the coordinator',
      "                                checkout, the loop's systemd unit; --replace-supervisor replaces",
      "                                another loop's.",
      '  master init --for PERSON --token-stdin   Register a personal master on the shared loop',
      '  master start AGENT_KIND       Launch the dedicated visible Herdr master session',
      '  master worker add FILE        Add an existing or launchable Herdr worker profile',
      '  master reviewer add FILE | remove NAME   Add or remove a reviewer launch profile',
      '  master producer add FILE | replace FILE | remove NAME  Manage proof-producer profiles',
      '  master review GY-N [PROFILE]  Launch the bound reviewer on the exact current candidate as the',
      '                                open request\'s next attempt; master run does this on its own,',
      '                                so it is the recovery path for a request nothing else answers',
      '  master setup [--apply]',
      '                                Plan, or set, each deployment variable derived from credentials',
      '                                saved on this host that the deployment lacks; secrets piped, audited by fingerprint',
      '  master harness [KIND] [--apply]  Generate the master\'s own harness permissions',
      '  master status                 One page: the serving commit against main, open items, the',
      '                                merge writer, live sessions and free worker profiles',
      '  master drain REASON           Let running heavy jobs finish and start no new merge trial, batch',
      '                                gate, declared check, worker verification or session suite on',
      '                                this host until master resume (another project\'s quiet window)',
      '  master resume                 Lift the drain: queued heavy jobs start again with all their gates',
      '  master update now             Take the newest verified build on the deploy watch\'s next pass,',
      '                                without waiting for a quiet moment',
      '  master dispatch GY-N PROFILE  Invite a worker to claim ready work in a visible tab',
      '  master lesson add TEXT [--for workers] [--enforceable] | remove ID | list',
      '                                Record a durable lesson the master reads on every launch;',
      '                                --for workers also carries it in worker prompts; --enforceable',
      '                                files an item turning it into code, removed once delivered',
      '  master brief set FILE REASON | show',
      '                                Keep the product brief (problem, users, success signals, bets,',
      '                                open questions; at most 800 words) the master prompt carries',
      '  master config FIELD=VALUE…   Tune owned run settings and profile accounts',
      '                                (accounts:PROFILE=a,b); credential paths stay operator-only.',
      '                                trialCap=N launchHotCelsius=C hostHeavyJobs=N until=TIME (hostHeavyJobs=auto removes the limit file):',
      '                                temporary limits that revert on their own at TIME',
      '  master emblem [set FILE]     Show whether the project has an emblem (who drew it, when), or',
      '                                store its SVG (one <svg> root, at most 8 KB), shown beside',
      '                                the project name and as the favicon',
      '  master usage [--days N]       The tokens the project\'s agents spent and their cost at the price',
      '                                sheet\'s rates: today, 7 days, 30 days, all time; by role, model',
      '                                and account; per shipped item; flat plans as API-equivalent',
      '  master run [--once] [--interval SECONDS]',
      '                                The durable coordination loop: snapshot, close, dispatch,',
      '                                merge writer, persist',
      '  master autonomy [--admin-token-stdin --apply]  Provision the master identity',
      '  master promote --admin-token-stdin  Promote a supervised install to autonomy once its reviewer',
      '                                App and profile are independent of you and every worker; audited',
      '  master create FILE|release GY-N|unblock GY-N|requirements GY-N FILE|rework GY-N REASON',
      '                                Apply intent at once with the master\'s identity',
      '  master hold GY-N REASON       Hold a released item out of dispatch; its worker keeps its lease',
      '  master message GY-N TEXT      Message the item\'s worker; shown and acknowledged at its next sync',
      '  master reply MESSAGE-ID TEXT  Reply to a message a reporter sent this Master (master status lists them)',
      '  master peer add NAME URL --token-file PATH | list | remove NAME',
      '                                Another install this Master messages, with a reporter token it issued',
      '  master peer issue --root DIR  Issue an install on this host its reporter identity from this',
      '                                session: the token lands under that install\'s config directory with',
      '                                mode 0600 and each Master records the peer; a session launched before',
      '                                the peer names the rerun after its pane is closed and relaunched',
      '  master send NAME TEXT         Message a peer install\'s Master; --reply MESSAGE-ID answers one of its messages',
      '  master priority GY-N 0|1|2|3 REASON  Change priority with an audit reason',
      '  master attest GY-N PROOF REASON  Attest a manual: proof on the exact current head',
      '  master defer GY-N NOT-BEFORE REASON  Hold an unleased post-deploy follow-up until NOT-BEFORE',
      '                                (ISO, at most 30 days away) and clear its blocker; no worker launch',
      ...closeHelp,
      '  master restart                Restart this host\'s master loop through its unit, detached',
      '                                only where no systemd user manager runs one',
      '  master environments [--create KIND,…] [--apply]  Agent accounts, quota, profiles',
      '  master guide                  Print the complete master-agent operating guide',
      ...registryHelp,
    ],
    async run(context) {
      const { id } = context;
      const { checkoutRoot } = await import('./context.js');
      const root = await checkoutRoot(context, `mainworks master ${id ?? ''}`.trimEnd());
      // The master's role instructions lead the guide.
      if (id === 'guide') {
        const [{ masterInstructions }, { masterGuide }] = await Promise.all([import('../master.js'), import('../master/guide.js')]);
        return console.log(`${masterInstructions}\n${masterGuide}`);
      }
      if (id === 'init') return masterInit(context, root);
      if (id === 'setup') {
        const [{ masterSetupCommand }, { loadStoredMasterConfig }] = await Promise.all([import('./master-setup.js'), import('../master.js')]);
        return masterSetupCommand(context, root, await loadStoredMasterConfig(root));
      }
      const [
        { openMasterSession, unhandled },
        { intentCommand },
        { peerCommand },
        { fleetCommand },
        { emblemCommand },
        { confinedMaster, operationsCommand },
        { lessonsCommand },
        { briefCommand },
        { loopCommand },
        { usageCommand },
      ] = await Promise.all([
        import('./master/session.js'),
        import('./master/intent.js'),
        import('./master/peers.js'),
        import('./master/fleet.js'),
        import('./master/emblem.js'),
        import('./master/operations.js'),
        import('./master/lessons.js'),
        import('./master/brief.js'),
        import('./master/loop.js'),
        import('./master/usage.js'),
      ]);
      const session = await openMasterSession(context, root);
      // Each concern under ./master/ answers its own subcommands; the first that knows the id handles it.
      // A confined master's `restart` is operations' loop request (GY-1658), not an act on the host's systemd it cannot reach.
      const concerns = id === 'restart' && confinedMaster() ? [operationsCommand] : [intentCommand, peerCommand, fleetCommand, emblemCommand, usageCommand, lessonsCommand, briefCommand, operationsCommand, loopCommand];
      for (const command of concerns) if (await command(session) !== unhandled) return;
      throw new Error(`There is no master ${id}; use master guide for the subcommands`);
    },
  },
  ...sessionCommands,
  inviteCommand,
  configCommand,
]);

const masterInit: typeof import('./master-init.js').masterInit = async (...args) => (await import('./master-init.js')).masterInit(...args);

export const derivedIntent: typeof import('./master/intent.js').derivedIntent = async (...args) => (await import('./master/intent.js')).derivedIntent(...args);
