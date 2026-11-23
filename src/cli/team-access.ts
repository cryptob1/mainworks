import { defineCommands } from './registry.js';

/** GY-3690: the install's public link setting, in one line. */
export const renderPublicLink = (setting: { on: boolean; by: string | null; at: string | null }) =>
  `Public link: ${setting.on ? 'on' : 'off'}${setting.by ? ` (set by ${setting.by} at ${setting.at})` : ' (never set; off by default)'}`;

export const teamAccessCommands = defineCommands([{
  name: 'team-access',
  help: [
    '  team-access status [--json]   Whether the owner turned this install\'s public link (Tailscale',
    '                                Funnel) on, who did and when; the loop runs Funnel only while on',
  ],
  async run(context) {
    if (context.id !== 'status') throw new Error('Usage: mainworks team-access status [--json]');
    const setting = await context.api('team-access/public-link');
    console.log(context.args.includes('--json') ? JSON.stringify(setting, null, 2) : renderPublicLink(setting));
  },
}]);
