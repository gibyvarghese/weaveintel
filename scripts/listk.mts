import { liveKaggleAdapter } from '@weaveintel/tools-kaggle';
const creds = { username: process.env.KAGGLE_USERNAME!, key: process.env.KAGGLE_KEY! };
for (const slug of ['arc-agi-3-scout-v3','arc-agi-3-scout-v4','arc-agi-3-entry-v12','arc-agi-3-entry-v13','arc-agi-3-entry-v14','arc-agi-3-v1','arc3-v1','arcagi3-scout-v1']) {
  try { const o = await liveKaggleAdapter.getKernelStatus(creds, `techlunch/${slug}`); console.log(slug, '=>', o.status); }
  catch (e: any) { console.log(slug, 'ERR', String(e.message).slice(0,80)); }
}
