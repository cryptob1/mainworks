// Concern: `mainworks lead slack connect|allow` — the factory's Slack app tokens and who may use it (GY-4073).
import { readSecretFromStdin } from '../context.js';
import { readSlackSettings, saveSlackSettings } from '../../master/slack.js';

export const slackUsage = 'Use lead slack connect CHANNEL-ID OWNER-SLACK-ID with the app token (xapp-) and bot token (xoxb-) on stdin, or lead slack allow SLACK-ID…';

/** Stores the tokens under the install directory (mode 0600) and binds one channel; prints nothing. */
export async function slackCommand(args: string[], directory: string, input = () => readSecretFromStdin(10_000)) {
  const [action, ...rest] = args;
  if (action === 'connect' && rest.length === 2) {
    const tokens = (await input()).split(/\s+/);
    const appToken = tokens.find(token => token.startsWith('xapp-')), botToken = tokens.find(token => token.startsWith('xoxb-'));
    if (!appToken || !botToken) throw new Error('Pipe both the app token (xapp-) and the bot token (xoxb-) on stdin');
    const previous = await readSlackSettings(directory);
    return saveSlackSettings(directory, { appToken, botToken, channel: rest[0], owner: rest[1], people: previous?.people ?? [] });
  }
  if (action === 'allow') {
    const settings = await readSlackSettings(directory);
    if (!settings) throw new Error('Connect Slack first with lead slack connect');
    return saveSlackSettings(directory, { ...settings, people: rest });
  }
  throw new Error(slackUsage);
}
