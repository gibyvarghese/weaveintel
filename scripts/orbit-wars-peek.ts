import { liveKaggleAdapter } from '@weaveintel/tools-kaggle';
async function main() {
  const creds = { username: process.env['KAGGLE_USERNAME']!, key: process.env['KAGGLE_KEY']! };
  const ref = process.argv[2] ?? 'techlunch/orbit-wars-diagnostic';
  const out = await liveKaggleAdapter.getKernelOutput(creds, ref);
  console.log(out.log ?? '');
  console.log('--- files ---', out.files);
}
main();
