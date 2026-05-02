/**
 * Orbit Wars head-to-head: pulls v6 (attack-coordination) and v8 (ultra-refined)
 * source from Kaggle, builds a self-play match kernel that runs N matches each
 * way, pushes it, waits, and prints the win-rate. Use this to decide which
 * kernel to actually submit.
 *
 * Usage:
 *   KAGGLE_USERNAME=... KAGGLE_KEY=... npx tsx scripts/orbit-wars-v6-vs-v8.ts
 */
import { liveKaggleAdapter } from '@weaveintel/tools-kaggle';

const V6 = 'techlunch/orbit-wars-v6-attack-coordination';
const V8 = 'techlunch/orbit-wars-v8-ultra-refined';
const N_MATCHES = 10; // 10 v6-as-p1 + 10 v8-as-p1 = 20 total

function extractSource(pulled: { source: string; metadata: Record<string, unknown> }): string {
  const raw = pulled.source ?? '';
  // If it's a notebook JSON, concatenate code cells. If it's a script, return as-is.
  try {
    const nb = JSON.parse(raw) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
    if (Array.isArray(nb.cells)) {
      return nb.cells
        .filter((c) => c.cell_type === 'code')
        .map((c) => (Array.isArray(c.source) ? c.source.join('') : c.source ?? ''))
        .join('\n\n# --- next cell ---\n\n');
    }
  } catch {
    /* not JSON — assume script */
  }
  return raw;
}

function rewriteAgentName(src: string, newName: string): string {
  // Rename top-level `def agent(` to `def agent_<newName>(`.
  return src.replace(/^def\s+agent\s*\(/m, `def ${newName}(`);
}

function buildHarness(srcV6: string, srcV8: string, n: number): string {
  return `# Auto-generated: orbit-wars v6 vs v8 head-to-head
import json, traceback, sys

# ─── v6 source ────────────────────────────────────────────────────────────
${rewriteAgentName(srcV6, 'agent_v6')}

# ─── v8 source ────────────────────────────────────────────────────────────
${rewriteAgentName(srcV8, 'agent_v8')}

# ─── Match runner ─────────────────────────────────────────────────────────
from kaggle_environments import make

def run_match(p1, p2, p1_name, p2_name, idx):
    env = make('orbit_wars', debug=False)
    try:
        env.run([p1, p2])
    except Exception as e:
        return {'idx': idx, 'p1': p1_name, 'p2': p2_name, 'error': repr(e)}
    final = env.state[-1] if env.state else None
    rewards = [s.get('reward') for s in env.state] if env.state else []
    # Determine winner: highest reward / final score wins
    try:
        r1 = float(env.state[0].get('reward') or 0)
        r2 = float(env.state[1].get('reward') or 0)
    except Exception:
        r1, r2 = 0.0, 0.0
    winner = p1_name if r1 > r2 else (p2_name if r2 > r1 else 'tie')
    return {
        'idx': idx,
        'p1': p1_name,
        'p2': p2_name,
        'r1': r1,
        'r2': r2,
        'winner': winner,
        'steps': len(env.steps) if hasattr(env, 'steps') else None,
    }

results = []
N = ${n}
print(f'═══ v6 as P1 vs v8 as P2 ({N} matches) ═══')
for i in range(N):
    r = run_match(agent_v6, agent_v8, 'v6', 'v8', i)
    print(json.dumps(r))
    results.append(r)

print(f'═══ v8 as P1 vs v6 as P2 ({N} matches) ═══')
for i in range(N):
    r = run_match(agent_v8, agent_v6, 'v8', 'v6', i)
    print(json.dumps(r))
    results.append(r)

# Tally
v6_wins = sum(1 for r in results if r.get('winner') == 'v6')
v8_wins = sum(1 for r in results if r.get('winner') == 'v8')
ties    = sum(1 for r in results if r.get('winner') == 'tie')
errors  = sum(1 for r in results if 'error' in r)
total   = len(results)
v6_avg  = sum(float(r.get('r1') if r['p1']=='v6' else r.get('r2', 0)) for r in results if 'error' not in r) / max(1, total - errors)
v8_avg  = sum(float(r.get('r1') if r['p1']=='v8' else r.get('r2', 0)) for r in results if 'error' not in r) / max(1, total - errors)

summary = {
    'total_matches': total,
    'v6_wins': v6_wins,
    'v8_wins': v8_wins,
    'ties': ties,
    'errors': errors,
    'v6_win_rate': v6_wins / max(1, total - errors),
    'v8_win_rate': v8_wins / max(1, total - errors),
    'v6_avg_reward': v6_avg,
    'v8_avg_reward': v8_avg,
    'recommendation': 'v6' if v6_wins > v8_wins else ('v8' if v8_wins > v6_wins else 'tie'),
}
print('═══ SUMMARY ═══')
print(json.dumps(summary, indent=2))

with open('/kaggle/working/cv_scores.json', 'w') as f:
    json.dump({'cv_score': summary['v6_win_rate'] - summary['v8_win_rate'], **summary}, f, indent=2)
with open('/kaggle/working/match_results.json', 'w') as f:
    json.dump(results, f, indent=2)

print('AGENT_RESULT_CV: cv_score=' + str(summary['v6_win_rate'] - summary['v8_win_rate']))
print('RECOMMENDATION: ' + summary['recommendation'])
`;
}

async function main() {
  const username = process.env['KAGGLE_USERNAME'];
  const key = process.env['KAGGLE_KEY'];
  if (!username || !key) {
    console.error('KAGGLE_USERNAME / KAGGLE_KEY required');
    process.exit(1);
  }
  const creds = { username, key };

  console.log('Pulling v6...');
  const v6 = await liveKaggleAdapter.pullKernel(creds, V6);
  const srcV6 = extractSource(v6);
  console.log(`  v6 source bytes: ${srcV6.length}`);

  console.log('Pulling v8...');
  const v8 = await liveKaggleAdapter.pullKernel(creds, V8);
  const srcV8 = extractSource(v8);
  console.log(`  v8 source bytes: ${srcV8.length}`);

  if (srcV6.length < 200 || srcV8.length < 200) {
    console.error('One of the kernels has no usable source. Aborting.');
    process.exit(2);
  }

  const harness = buildHarness(srcV6, srcV8, N_MATCHES);
  console.log(`Harness bytes: ${harness.length}`);

  const slug = `${username}/orbit-wars-compare-v6-v8`;
  console.log(`Pushing harness as ${username}/${slug} ...`);
  const push = await liveKaggleAdapter.pushKernel(creds, {
    slug,
    title: `Orbit Wars v6 vs v8 (${N_MATCHES * 2} matches)`,
    source: harness,
    kernelType: 'script',
    language: 'python',
    isPrivate: true,
    competitionSource: 'orbit-wars',
    enableInternet: false,
    enableGpu: false,
  });
  console.log('Pushed:', push);
  // Push returns ref like '/code/techlunch/<slug>'. Normalize to owner/slug.
  const m = (push.url || '').match(/code\/([^/]+)\/([^/?#]+)/);
  const ref = m ? `${m[1]}/${m[2]}` : push.ref;
  console.log('Polling ref:', ref);

  console.log('Waiting for output (poll every 20s, max 12 min)...');
  const deadline = Date.now() + 12 * 60_000;
  let out: Awaited<ReturnType<typeof liveKaggleAdapter.getKernelOutput>> | null = null;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    try {
      out = await liveKaggleAdapter.getKernelOutput(creds, ref);
      const hasLog = (out.log ?? '').includes('SUMMARY');
      const hasFile = (out.files ?? []).some((f) => f.fileName === 'cv_scores.json');
      process.stdout.write(`  output: log=${(out.log ?? '').length}b files=${(out.files ?? []).length} done=${hasLog || hasFile}\n`);
      if (hasLog || hasFile) break;
    } catch (e) {
      lastErr = e;
      process.stdout.write(`  poll err: ${(e as Error).message.slice(0, 120)}\n`);
    }
  }
  if (!out) {
    console.error('No output retrieved. Last error:', lastErr);
    console.log(`Inspect manually: ${push.url}`);
    return;
  }
  console.log('--- LOG TAIL (5KB) ---');
  console.log((out.log ?? '').slice(-5000));
  console.log('--- FILES ---');
  console.log(out.files);

  const summaryFile = (out.files ?? []).find((f) => f.fileName === 'cv_scores.json');
  if (summaryFile?.url) {
    try {
      const r = await fetch(summaryFile.url);
      if (r.ok) {
        const txt = await r.text();
        console.log('--- SUMMARY (cv_scores.json) ---');
        console.log(txt);
      }
    } catch (err) {
      console.error('Failed to fetch summary file:', err);
    }
  }

  console.log(`\nKernel URL: ${push.url}`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
