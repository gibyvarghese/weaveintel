// Submit a Kaggle agent. Two modes:
//   1) Default: download main.py from a completed kernel, then submit it.
//      node --env-file=.env --import tsx scripts/submit-orbit-wars.ts [kernelRef] [competitionRef]
//   2) Local file: submit a main.py already on disk (skips the kernel fetch).
//      node --env-file=.env --import tsx scripts/submit-orbit-wars.ts --file /tmp/orbit-sub/main.py [competitionRef] [description]
import { liveKaggleAdapter } from '@weaveintel/tools-kaggle';
import fs from 'node:fs';

const creds = {
  username: process.env['KAGGLE_USERNAME']!,
  key: process.env['KAGGLE_KEY']!,
};
if (!creds.username || !creds.key) throw new Error('KAGGLE_USERNAME / KAGGLE_KEY required in .env');

let fileContent: string;
let competitionRef: string;
let description: string;

if (process.argv[2] === '--file') {
  const filePath = process.argv[3];
  competitionRef = process.argv[4] ?? 'orbit-wars';
  description = process.argv[5] ?? `weaveintel local submit — ${filePath}`;
  if (!filePath) throw new Error('--file requires a path');
  fileContent = fs.readFileSync(filePath, 'utf8');
  console.log(`▸ Read ${fileContent.length} bytes from ${filePath}`);
} else {
  const kernelRef = process.argv[2] ?? 'techlunch/orbit-wars-v5-ensemble-adaptive-logic';
  competitionRef = process.argv[3] ?? 'orbit-wars';
  description = `weaveintel autonomous agent — ${kernelRef}`;
  console.log(`▸ Fetching kernel output for ${kernelRef}…`);
  const out = await liveKaggleAdapter.getKernelOutput(creds, kernelRef);
  const mainPy = out.files.find((f) => f.fileName === 'main.py');
  if (!mainPy) {
    console.error('No main.py in kernel output. Files present:', out.files.map((f) => f.fileName));
    process.exit(1);
  }
  const resp = await fetch(mainPy.url);
  if (!resp.ok) throw new Error(`Download failed ${resp.status}`);
  fileContent = await resp.text();
  fs.mkdirSync('/tmp/orbit-sub', { recursive: true });
  fs.writeFileSync('/tmp/orbit-sub/main.py', fileContent);
  console.log(`▸ Downloaded ${fileContent.length} bytes → /tmp/orbit-sub/main.py`);
}

console.log(`▸ Submitting to ${competitionRef}…`);
const result = await liveKaggleAdapter.submitToCompetition(creds, {
  competitionRef,
  fileName: 'main.py',
  fileContent,
  description,
});
console.log('▸ Submission result:', JSON.stringify(result, null, 2));
console.log(`▸ Track at https://www.kaggle.com/competitions/${competitionRef}/submissions`);
