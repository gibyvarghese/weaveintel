import { createDatabaseAdapter } from '../apps/geneweave/src/db.ts';
import { seedKaggleArcPlaybook } from '../apps/geneweave/src/live-agents/kaggle/playbook-seed.ts';
import { createDbKagglePlaybookResolver, extractCompetitionSlugFromText } from '../apps/geneweave/src/live-agents/kaggle/playbook-resolver.ts';
const db = await createDatabaseAdapter({ type: 'sqlite', path: './geneweave.db' });
const r = await seedKaggleArcPlaybook(db);
console.log('Seed result:', r);
const resolver = createDbKagglePlaybookResolver(db);
for (const slug of ['arc-prize-2025', 'arc-agi-3-public-2025', 'titanic', null]) {
  const p = await resolver(slug);
  console.log('slug=', slug, ' => playbook:', p ? { skillId: p.skillId, hasSolverTemplate: !!p.solverTemplate, configKeys: Object.keys(p.config), promptLen: p.systemPrompt.length } : null);
}
console.log('extract test 1:', extractCompetitionSlugFromText('We are working on competitions/arc-prize-2025 today'));
console.log('extract test 2:', extractCompetitionSlugFromText('{"competitionId":"titanic"}'));
