import type { CliCommand } from './registry.js';
import { asRecordedOperator } from './session-commands.js';
import { authorLine } from '../check-in-author.js';

/** GY-3850: the owner every commit is authored by as 'NAME (Mainworks) <EMAIL>'; it applies from the next commit. */
export const configCommand: CliCommand = {
  name: 'config',
  help: ['  config owner "NAME" EMAIL    Author every commit as \'NAME (Mainworks) <EMAIL>\' from the next one; config owner alone shows it'],
  async run(context) {
    const [name, email, ...rest] = context.args;
    if (context.id !== 'owner' || rest.length || (name !== undefined && email === undefined)) throw new Error('Usage: mainworks config owner "NAME" EMAIL');
    await asRecordedOperator(context.repositoryRoot());
    const answer = await context.api('owner', ...(name === undefined ? [] : [{ name, email }])) as { owner: { name: string; email: string } | null };
    return context.print({ owner: answer.owner, author: authorLine(answer.owner), ...(answer.owner ? {} : { next: 'Run mainworks config owner "NAME" EMAIL' }) });
  },
};
