import { liveKaggleAdapter } from '@weaveintel/tools-kaggle';

async function main() {
  const creds = { username: process.env['KAGGLE_USERNAME']!, key: process.env['KAGGLE_KEY']! };
  const ref = 'techlunch/orbit-wars-v6-vs-v8-20-matches';
  console.log('Polling', ref);
  const deadline = Date.now() + 12 * 60_000;
  let out: Awaited<ReturnType<typeof liveKaggleAdapter.getKernelOutput>> | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    try {
      out = await liveKaggleAdapter.getKernelOutput(creds, ref);
      const hasSum = (out.log ?? '').includes('SUMMARY');
      const hasFile = (out.files ?? []).some((f) => f.fileName === 'cv_scores.json');
      console.log(`log=${(out.log ?? '').length}b files=${(out.files ?? []).length} done=${hasSum || hasFile}`);
      if (hasSum || hasFile) break;
    } catch (e) {
      console.log('err:', (e as Error).message.slice(0, 120));
    }
  }
  if (!out) return;
  console.log('--- LOG TAIL ---');
  console.log((out.log ?? '').slice(-4000));
  console.log('--- FILES ---');
  console.log(out.files);
  const f = (out.files ?? []).find((x) => x.fileName === 'cv_scores.json');
  if (f?.url) {
    const r = await fetch(f.url);
    console.log('--- cv_scores.json ---');
    console.log(await r.text());
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
