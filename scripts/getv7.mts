import { liveKaggleAdapter } from '@weaveintel/tools-kaggle';
const creds = { username: process.env.KAGGLE_USERNAME!, key: process.env.KAGGLE_KEY! };
const refs = Array.from({length:11},(_,i)=>`techlunch/arc-agi-3-entry-v${i+1}`);
for (const r of refs) {
  try {
    const o = await liveKaggleAdapter.getKernelOutput(creds, r);
    const log = o.log ?? '';
    const m = log.match(/AGENT_RESULT:[^"\\]{0,200}/);
    const errs = (log.match(/error:[^\\"\n]{0,80}/g) ?? []).length;
    console.log(r.padEnd(34), m ? m[0] : '(no AGENT_RESULT)', '  errCount=', errs, ' logBytes=', log.length);
  } catch (e) { console.log(r,'FAIL',(e as Error).message); }
}
