import { createGeneWeave, geneweaveEncryptionManager } from '../apps/geneweave/dist/index.js';

const app = await createGeneWeave({ databasePath: '/tmp/test-enc.db', defaultProvider: 'openai', providers: { openai: { apiKey: 'sk-test-stub' } }, port: 0 });
const row = await app.db.getTenantEncryptionPolicy('demo-encrypted-tenant');
console.log('seed row:', row);
console.log('manager bootstrapped:', !!geneweaveEncryptionManager);
process.exit(0);
