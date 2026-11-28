import { defineCommands } from './registry.js';
import { sessionCommands } from './session-commands.js';
import { inviteCommand } from './invite.js';
import { configCommand } from './config-owner.js';
import { registryHelp } from './master-registry-help.js';
import { closeHelp } from './master-close.js';

/** Every master subcommand authenticates with the coordinator credential the master keeps for itself, never the repository connection file. */
export const masterCommands = defineCommands([
  {
    name: 'lead',
    aliases: ['master'],
    readsConnection: () => false,
    help: [
      '  lead init --token-stdin [--herdr-workspace ID]',
      '              [--reviewer-profile NAME] [--producer-timeout MINUTES]',
      '              [--replace-supervisor] Install the operating mode and, in the lead\'s',
      "                                checkout, the loop's systemd unit; --replace-supervisor replaces",
      "                                another loop's.",
      '  lead init --for PERSON --token-stdin   Register a personal lead on the shared loop',
      '  lead start AGENT_KIND         Launch the dedicated visible Herdr lead session',
      '  lead worker add FILE          Add an existing or launchable Herdr worker profile',
      '  lead reviewer add FILE | remove NAME   Add or remove a reviewer launch profile',
      '  lead producer add FILE | replace FILE | remove NAME  Manage proof-producer profiles',
      '  lead review GY-N [PROFILE]    Launch the bound reviewer on the exact current candidate as the',
      '                                open request\'s next attempt; lead run does this on its own,',
      '                                so it is the recovery path for a request nothing else answers',
      '  lead setup [--apply]',
      '                                Plan, or set, each deployment variable derived from credentials',
      '                                saved on this host that the deployment lacks; secrets piped, audited by fingerprint',
      '  lead harness [KIND] [--apply]  Generate the lead\'s own harness permissions',
      '  lead status                   One page: the serving commit against main, open items, the',
      '                                merge writer, live sessions and free worker profiles',
      '  lead drain REASON             Let running heavy jobs finish and start no new merge trial, batch',
      '                                gate, declared check, worker verification or session suite on',
      '                                this host until lead resume (another project\'s quiet window)',
      '  lead resume                   Lift the drain: queued heavy jobs start again with all their gates',
      '  lead public-link off          Turn the install\'s public link off; only the owner turns it on',
      '  lead update now               Take the newest verified build on the deploy watch\'s next pass,',
      '                                without waiting for a quiet moment',
      '  lead dispatch GY-N PROFILE    Invite a worker to claim ready work in a visible tab',
      '  lead lesson add TEXT [--for workers] [--enforceable] | remove ID | list',
      '                                Record a durable lesson the lead reads on every launch;',
      '                                --for workers also carries it in worker prompts; --enforceable',
      '                                files an item turning it into code, removed once delivered',
      '  lead brief set FILE REASON | show',
      '                                Keep the product brief (problem, users, success signals, bets,',
      '                                open questions; at most 800 words) the lead prompt carries',
      '  lead config FIELD=VALUE…      Tune owned run settings and profile accounts',
      '                                (accounts:PROFILE=a,b); credential paths stay operator-only.',
      '                                planner=off|on turns the planner off or back on;',
      '                                trialCap=N launchHotCelsius=C hostHeavyJobs=N until=TIME (hostHeavyJobs=auto removes the limit file):',
      '                                temporary limits that revert on their own at TIME',
      '  lead emblem [set FILE]        Show whether the project has an emblem (who drew it, when), or',
      '                                store its SVG (one <svg> root, at most 8 KB), shown beside',
      '                                the project name and as the favicon',
      '  lead usage [--days N]         The tokens the project\'s agents spent and their cost at the price',
      '                                sheet\'s rates: today, 7 days, 30 days, all time; by role, model',
      '                                and account; per shipped item; flat plans as API-equivalent',
      '  lead run [--once] [--interval SECONDS]',
      '                                The durable coordination loop: snapshot, close, dispatch,',
      '                                merge writer, persist',
      '  lead autonomy [--admin-token-stdin --apply]  Provision the lead identity',
      '  lead promote --admin-token-stdin  Promote a supervised install to autonomy once its reviewer',
      '                                App and profile are independent of you and every worker; audited',
      '  lead create FILE|release GY-N|unblock GY-N|requirements GY-N FILE|rework GY-N REASON',
      '                                Apply intent at once with the lead\'s identity',
      '  lead hold GY-N REASON         Hold a released item out of dispatch; its worker keeps its lease',
      '  lead message GY-N TEXT        Message the item\'s worker; shown and acknowledged at its next sync',
      '  lead reply MESSAGE-ID TEXT    Reply to a message a reporter sent this Lead (lead status lists them)',
      '  lead peer add NAME URL --token-file PATH | list | remove NAME',
      '                                Another install this Lead messages, with a reporter token it issued',
      '  lead peer issue --root DIR    Issue an install on this host its reporter identity from this',
      '                                session: the token lands under that install\'s config directory with',
      '                                mode 0600 and each Lead records the peer; a session launched before',
      '                                the peer names the rerun after its pane is closed and relaunched',
      '  lead slack connect CHANNEL-ID OWNER-SLACK-ID  Connect the factory\'s Slack app: its app and bot',
      '                                tokens on stdin, kept in the install directory; the channel\'s',
      '                                messages reach the Lead and its replies post in thread',
      '  lead slack allow SLACK-ID…    The people besides the owner whose Slack messages reach the Lead',
      '  lead send NAME TEXT           Message a peer install\'s Lead; --reply MESSAGE-ID answers one of its messages',
      '  lead priority GY-N 0|1|2|3 REASON  Change priority with an audit reason',
      '  lead attest GY-N PROOF REASON  Attest a manual: proof on the exact current head',
      '  lead defer GY-N NOT-BEFORE REASON  Hold an unleased post-deploy follow-up until NOT-BEFORE',
      '                                (ISO, at most 30 days away) and clear its blocker; no worker launch',
      ...closeHelp,
      '  lead restart                  Restart this host\'s lead loop through its unit, detached',
      '                                only where no systemd user manager runs one',
      '  lead environments [--create KIND,…] [--apply]  Agent accounts, quota, profiles',
      '  lead guide                    Print the complete lead-agent operating guide',
      ...registryHelp,
    ],
    async run(context) {
      const { id } = context;
      const { checkoutRoot } = await import('./context.js');
      const root = await checkoutRoot(context, `mainworks lead ${id ?? ''}`.trimEnd());
      // The master's role instructions lead the guide.
      if (id === 'guide') {
        const [{ masterInstructions }, { masterGuide }] = await Promise.all([import('../master/instructions.js'), import('../master/guide.js')]);
        return console.log(`${masterInstructions}\n${masterGuide}`);
      }
      if (id === 'init') return masterInit(context, root);
      if (id === 'slack') {
        const [{ slackCommand }, { loadStoredMasterConfig }, { installDirectory }, { installIdFor }] = await Promise.all([import('./master/slack.js'), import('../master/config.js'), import('../install/secrets.js'), import('../install/types.js')]);
        return slackCommand(context.args, installDirectory(installIdFor((await loadStoredMasterConfig(root)).repository)));
      }
      if (id === 'setup') {
        const [{ masterSetupCommand }, { loadStoredMasterConfig }] = await Promise.all([import('./master-setup.js'), import('../master/config.js')]);
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
      throw new Error(`There is no lead ${id}; use lead guide for the subcommands`);
    },
  },
  ...sessionCommands,
  inviteCommand,
  configCommand,
]);

const masterInit: typeof import('./master-init.js').masterInit = async (...args) => (await import('./master-init.js')).masterInit(...args);

