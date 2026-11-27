import { defineCommands } from './registry.js';
import { PRODUCT_NAME } from '../model/product.js';

/**
 * `guide TOPIC` prints one procedure topic; with no topic it lists them (GY-2972). The
 * launched instruction stays short and names the topics its role needs, so reading a
 * procedure is this one local command: it reads no connection file and talks to no server.
 */
export const guideCommands = defineCommands([
  {
    name: 'guide',
    readsConnection: () => false,
    help: [
      '  guide TOPIC                   Print one procedure topic',
      '                                (topics: claim, sync, complete, park, blocked, review, proof, upgrade, lead, setup, infra, publishing, runtimes);',
      '                                guide with no topic lists them; guide lead says how',
      `                                Railway deploys apps from git and ${PRODUCT_NAME} observes each versionUrl`,
    ],
    async run(context) {
      const { guideList, guideText } = await import('../guide.js');
      console.log(context.id ? guideText(context.id) : guideList());
    },
  },
]);
