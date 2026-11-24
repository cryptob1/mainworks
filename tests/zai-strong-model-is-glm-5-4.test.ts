import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { connectProviders, discoverHostLogins, proposeFleet } from '../src/fleet.js';
import { seedPrices } from '../src/model/price-sheet.js';
import { costFigure, costSummary } from '../src/model/token-costs.js';

// GY-3705: GLM 5.4 is the strong Z.AI model a new install is proposed; Z.AI has not priced it yet.
test('unit:zai-strong-model-is-glm-5-4 — OpenCode and Pi logins on Z.AI are proposed glm-5.4, Pi writes it as its default, and its sessions read price unknown until Z.AI prices it', async () => {
  const directory = await temporaryDirectory('zai-glm-5-4'), home = await temporaryDirectory('zai-glm-5-4-home');
  await mkdir(join(directory, 'opencode-a', 'opencode'), { recursive: true });
  await writeFile(join(directory, 'opencode-a', 'opencode', 'auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: 'k' } }));
  await mkdir(join(directory, 'pi-a'), { recursive: true });
  await writeFile(join(directory, 'pi-a', 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'k' } }));
  const logins = (await discoverHostLogins({ directory, home, executables: () => false })).filter(login => login.runtime === 'opencode' || login.runtime === 'pi');
  const proposal = proposeFleet(logins, 'host', undefined, () => null);
  const strong = (runtime: string) => {
    const account = proposal.accounts.find(entry => entry.runtime === runtime)!;
    const model = proposal.models.find(entry => entry.name === account.model)!;
    return [model.id, model.capability.tier];
  };
  assert.deepEqual(strong('opencode'), ['zai-coding-plan/glm-5.4', 'strong']);
  assert.deepEqual(strong('pi'), ['zai/glm-5.4', 'strong']);

  const pi = connectProviders.find(provider => provider.id === 'pi-zai')!;
  assert.equal(pi.settings!.document({}).defaultModel, 'glm-5.4');
  const zai = connectProviders.find(provider => provider.id === 'z.ai')!;
  assert.ok(zai.smoke.args.includes('zai-coding-plan/glm-5.3-flash'), 'the fast model is unchanged');

  const sheet = seedPrices.map(price => price.id);
  assert.ok(sheet.includes('glm-5.3') && sheet.includes('glm-5.3-flash') && !sheet.includes('glm-5.4'));
  const row = { id: 's', work: null, role: 'worker', account: 'opencode-a', runtime: 'opencode', model: 'glm-5.4', reported: true, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, at: new Date().toISOString() };
  const summary = costSummary([row], { models: proposal.models, accounts: [] }, new Set(), Date.now());
  assert.equal(costFigure(summary.models[0]), 'price unknown');
});
