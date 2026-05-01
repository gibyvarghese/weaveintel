import { liveKaggleAdapter } from '@weaveintel/tools-kaggle';
const creds = { username: process.env.KAGGLE_USERNAME!, key: process.env.KAGGLE_KEY! };
const o = await liveKaggleAdapter.getKernelOutput(creds, 'techlunch/arc-agi-3-entry-v11');
const log = o.log ?? '';
console.log('=== v11 tail ===');
console.log(log.slice(-3500));
