/**
 * @weaveintel/cache — Semantic cache APP-LEVEL benchmark.
 *
 * This is NOT a model-quality benchmark (no MMLU/answer-correctness). It measures
 * the *caching application layer*: given a labeled set of query pairs, how well does
 * `weaveSemanticCache` decide "is this a cache hit?" — i.e. precision, recall, F1,
 * false-positive rate and hit-rate as a function of the cosine threshold.
 *
 * Methodology (after GPTCache / SCALM / MeanCache evaluation practice):
 *   - A balanced dataset (equal duplicate vs. unrelated pairs) to avoid bias.
 *     MeanCache: "equal distributions of duplicate and non-duplicate queries".
 *   - Each pair is classified independently with a fresh single-entry cache:
 *     store(A) then find(B). A *duplicate* B should hit; an *unrelated* B should miss.
 *   - Sweep the threshold 0.60 → 0.95 (research sweeps 0.6–0.9 in 0.05 steps) and
 *     compute the IR confusion matrix at each step.
 *   - The content is deliberately LONG and COMPLICATED — multi-paragraph prompts with
 *     embedded code, JSON, SQL, logs and numeric tables — because that is where naive
 *     exact/prefix caches fail and where threshold choice actually matters.
 *
 * Published app-level targets we compare against (see PR description / research notes):
 *   - Positive-hit (precision):  ~92–98%   (JSAER 2024; GPT Semantic Cache)
 *   - False-positive rate:       ≤ ~1%     (0.8% cited as acceptable; Spheron 0.92 start)
 *   - Recall-oriented threshold: ~0.88     |  Precision-oriented: ~0.94
 *
 * The embedding here is a deterministic bag-of-words/bigram hash (no model, no network)
 * so the benchmark is reproducible in CI. Absolute numbers will differ from a real
 * embedding model; the *shape* of the curve (precision↑ / recall↓ as threshold rises)
 * and the cache's threshold-gating behaviour are what this guards.
 *
 * Per the chosen mode this benchmark REPORTS the full metric table and uses only loose
 * soft assertions, so day-to-day threshold tuning does not turn into CI noise.
 */
import { describe, it, expect } from 'vitest';
import { weaveSemanticCache } from '../src/index.js';

// ─── Deterministic, model-free embedding ─────────────────────
// TF over content tokens (+ half-weight bigrams). Stopwords removed so the signal is
// dominated by domain vocabulary, which is what separates paraphrases from unrelated text.

const STOP = new Set(
  ('the a an and or of to in for on with is are be that this it as at by from our we you your i ' +
   'please can could would should will do does if then than but not no use using given here have ' +
   'has they their these those which what how when where also into out over per via etc me my mit so ' +
   'about each one two three need want make made get got such may might must been being was were').split(/\s+/),
);

// Conservative suffix stripping so morphological variants of the SAME content word collapse
// to one token (pages→page, buffering→buffer, returns→return, indexing→index). This is plain
// IR stemming — it raises true-paraphrase overlap honestly; it does not invent cross-document
// similarity (unrelated domains share almost no stems, so the FPR margin stays large).
function stem(w: string): string {
  let s = w;
  if (s.length > 5) s = s.replace(/(ization|isations?|izations?)$/, 'ize');
  if (s.length > 5) s = s.replace(/(ements?| encies?|ancies?)$/, '');
  if (s.length > 4) s = s.replace(/(ing|ings)$/, '');
  if (s.length > 4) s = s.replace(/(edly|edness)$/, '');
  if (s.length > 4) s = s.replace(/(ed|es|s)$/, '');
  if (s.length > 4) s = s.replace(/(tion|sion)$/, 't');
  return s;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length > 2 && !STOP.has(t))
    .map(stem)
    .filter((t) => t.length > 2);
}

// FNV-1a → bucket. Math.imul keeps it a 32-bit hash; no Date/Math.random (CI-deterministic).
function bucket(token: string, dim: number): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % dim;
}

function embedText(text: string): number[] {
  const dim = 2048;
  const v = new Array(dim).fill(0);
  // Unigram TF only. Bigrams were tried but their order-sensitivity penalised reworded
  // paraphrases (true duplicates), pushing their cosine below the published 0.88–0.92
  // operating band; shared domain unigrams + identical embedded code blocks already
  // separate duplicates from unrelated prompts cleanly.
  for (const t of tokenize(text)) v[bucket(t, dim)] += 1;
  return v;
}
const embed = async (t: string) => embedText(t);

// ─── Dataset: long, complicated prompts ──────────────────────
// Each `doc` has a base prompt `a` and a paraphrase `b` (a true duplicate — same intent,
// different surface form). Unrelated pairs are synthesised by crossing different docs.

interface Doc { domain: string; a: string; b: string }

const DOCS: Doc[] = [
  {
    domain: 'ts-refactor',
    a: `I have a TypeScript module that paginates an API. Please refactor this so it uses async iterators
instead of collecting every page into one array, keeps the existing retry-with-backoff behaviour, and stays
strongly typed. Current code:
\`\`\`ts
async function fetchAll(url: string): Promise<Item[]> {
  let page = 0; const out: Item[] = [];
  while (true) {
    const res = await retry(() => http.get(\`\${url}?page=\${page}\`));
    out.push(...res.items);
    if (!res.hasMore) break; page++;
  }
  return out;
}
\`\`\`
Explain the memory trade-off of streaming pages versus buffering them all in memory.`,
    b: `Can you rewrite the TypeScript pagination helper below to yield pages lazily through an async generator
rather than buffering all results into a single array? Keep the retry-and-backoff logic intact and preserve the
static types. The code I want changed is:
\`\`\`ts
async function fetchAll(url: string): Promise<Item[]> {
  let page = 0; const out: Item[] = [];
  while (true) {
    const res = await retry(() => http.get(\`\${url}?page=\${page}\`));
    out.push(...res.items);
    if (!res.hasMore) break; page++;
  }
  return out;
}
\`\`\`
Also describe how streaming pages changes memory usage compared with collecting everything up front.`,
  },
  {
    domain: 'sql-tuning',
    a: `This Postgres query powering our analytics dashboard takes 14 seconds on a 40M-row orders table.
\`\`\`sql
SELECT customer_id, SUM(total_cents) AS revenue
FROM orders
WHERE created_at >= now() - interval '90 days'
GROUP BY customer_id
ORDER BY revenue DESC LIMIT 100;
\`\`\`
There is a btree index on created_at only. Suggest indexing and rewrite strategies (covering index, partial
index, pre-aggregation) and explain which the planner will actually use and why the sort is expensive.`,
    b: `Our reporting dashboard runs the Postgres aggregation below against a 40-million-row orders table and it
needs roughly 14 seconds. We only have a btree index on created_at. How should I add indexes or restructure it —
a covering index, a partial index, or a rollup table — to speed it up, and which option does the query planner
prefer? The statement is:
\`\`\`sql
SELECT customer_id, SUM(total_cents) AS revenue
FROM orders
WHERE created_at >= now() - interval '90 days'
GROUP BY customer_id
ORDER BY revenue DESC LIMIT 100;
\`\`\`
Why is the ORDER BY so costly here?`,
  },
  {
    domain: 'devops-postmortem',
    a: `Write an incident postmortem. At 02:14 UTC our checkout service returned 503s for 22 minutes after a
deploy. The pod logs show repeated lines:
\`\`\`
ERROR pool exhausted: 100/100 connections in use, waiters=312
WARN  pg: remaining connection slots reserved for superuser
\`\`\`
Root cause was a new code path opening a connection per request without releasing it. Cover impact, timeline,
the five-whys root cause, the immediate mitigation (rollback + pool cap), and durable fixes (connection
lifecycle, max pool, load-test gate). Audience is engineering leadership.`,
    b: `I need a postmortem document for leadership. Following a deploy, the checkout service threw 503 errors for
22 minutes starting 02:14 UTC; the logs were full of:
\`\`\`
ERROR pool exhausted: 100/100 connections in use, waiters=312
WARN  pg: remaining connection slots reserved for superuser
\`\`\`
The cause was a regression that grabbed a database connection on every request and never returned it. Please
structure it with customer impact, a timeline, a five-whys analysis, the short-term mitigation we did (rolled
back and capped the pool), and the longer-term prevention work around connection handling and load testing.`,
  },
  {
    domain: 'rag-policy',
    a: `Using ONLY the refund policy below, answer the customer question. Do not invent terms.
POLICY: "Physical goods may be returned within 30 days of delivery for a full refund if unused and in original
packaging. Opened electronics incur a 15% restocking fee. Digital downloads are non-refundable once accessed.
Shipping costs are refunded only when the return is due to our error."
QUESTION: A customer bought headphones, opened the box, used them for a week, and now wants a full refund
including the shipping they paid. What are they entitled to? Quote the relevant clauses.`,
    b: `Answer the buyer's query strictly from this returns policy and quote the exact clauses you rely on — no
information beyond the text.
POLICY: "Physical goods may be returned within 30 days of delivery for a full refund if unused and in original
packaging. Opened electronics incur a 15% restocking fee. Digital downloads are non-refundable once accessed.
Shipping costs are refunded only when the return is due to our error."
QUESTION: Someone purchased headphones, unsealed them, used them for about a week, and is now requesting a
complete refund plus reimbursement of the shipping fee they paid. What can they actually get back?`,
  },
  {
    domain: 'finance-analysis',
    a: `Analyse this quarterly P&L and tell me whether the unit economics are improving. Q1: revenue $1.20M, COGS
$0.54M, S&M $0.40M, R&D $0.30M, churn 4.1%, CAC $410, ARPU $58. Q2: revenue $1.55M, COGS $0.66M, S&M $0.46M, R&D
$0.31M, churn 3.4%, CAC $390, ARPU $61. Compute gross margin, contribution margin, LTV:CAC for each quarter and
state plainly whether efficiency is trending up or down, with the two numbers that matter most.`,
    b: `Look at the two quarters of P&L data below and judge if the per-customer economics are getting better.
Q1 had revenue of $1.20M, COGS $0.54M, sales & marketing $0.40M, R&D $0.30M, 4.1% churn, $410 CAC and $58 ARPU;
Q2 had $1.55M revenue, $0.66M COGS, $0.46M S&M, $0.31M R&D, 3.4% churn, $390 CAC and $61 ARPU. Work out gross
margin, contribution margin and the LTV-to-CAC ratio for both quarters and tell me clearly whether efficiency is
improving, calling out the two most important figures.`,
  },
  {
    domain: 'k8s-yaml',
    a: `Review this Kubernetes Deployment for production-readiness problems and return a corrected manifest.
\`\`\`yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: api
          image: registry/api:latest
          ports: [{ containerPort: 8080 }]
\`\`\`
Specifically flag the missing resource requests/limits, missing liveness/readiness probes, the mutable :latest
tag, single replica with no PodDisruptionBudget, and no securityContext.`,
    b: `Audit the Kubernetes Deployment YAML below for things that would bite us in production and give me a fixed
version. The manifest:
\`\`\`yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: api
          image: registry/api:latest
          ports: [{ containerPort: 8080 }]
\`\`\`
I especially want you to call out the absent CPU/memory requests and limits, the lack of readiness and liveness
probes, pinning away from the floating :latest image tag, running a single replica without a disruption budget,
and the missing security context.`,
  },
  {
    domain: 'legal-summary',
    a: `Summarise the key obligations in this contract clause for a non-lawyer founder, then list the three
biggest risks. CLAUSE: "The Provider shall indemnify and hold harmless the Client against any third-party claims
arising from the Provider's gross negligence, provided that the Client gives written notice within fifteen (15)
business days and the aggregate liability shall not exceed the fees paid in the preceding twelve (12) months.
This limitation shall not apply to breaches of confidentiality or intellectual-property infringement."`,
    b: `Explain, in plain English for a founder with no legal background, what the following contract paragraph
actually commits each side to, and then flag the three largest risks in it. PARAGRAPH: "The Provider shall
indemnify and hold harmless the Client against any third-party claims arising from the Provider's gross
negligence, provided that the Client gives written notice within fifteen (15) business days and the aggregate
liability shall not exceed the fees paid in the preceding twelve (12) months. This limitation shall not apply to
breaches of confidentiality or intellectual-property infringement."`,
  },
  {
    domain: 'ml-tuning',
    a: `My gradient-boosted model overfits: training AUC is 0.95 but validation AUC is 0.71 on a tabular dataset
of 80k rows and 120 features. Current params: n_estimators=2000, max_depth=12, learning_rate=0.3, subsample=1.0,
no early stopping, no regularisation. Recommend a concrete regularisation and tuning plan (depth, learning rate,
subsample/colsample, early stopping rounds, monotonic constraints) and explain why each change reduces variance.`,
    b: `I'm training a gradient-boosting classifier on tabular data (80,000 rows, 120 columns) and it clearly
overfits — 0.95 AUC in training versus only 0.71 on the validation split. Right now I use n_estimators=2000,
max_depth=12, learning_rate=0.3, subsample=1.0, no early stopping and no regularisation. Give me a specific plan
to fix the overfitting — tree depth, the learning rate, row/column subsampling, early-stopping rounds,
regularisation terms — and say why each one lowers variance.`,
  },
  {
    domain: 'support-triage',
    a: `Triage and draft a reply to this support ticket. TICKET: "Hi, since the update yesterday the mobile app
crashes every time I open the Reports tab. I'm on iPhone 14, iOS 17.4, app version 8.2.1. I've reinstalled twice.
This is blocking my month-end close and I'm furious — if it's not fixed today I'm cancelling." Classify severity
and category, identify the likely cause (regression in 8.2.1 reports view on iOS 17.4), and write an empathetic,
specific response with next steps and a workaround.`,
    b: `Please categorise this customer support message and write a response. The message: "Hello — ever since
yesterday's update your mobile app crashes the moment I tap the Reports tab. iPhone 14, iOS 17.4, app build
8.2.1, and I've already reinstalled it twice. It's holding up my month-end close and I am extremely frustrated;
fix it today or I'm cancelling my subscription." Decide the severity and type, point to the probable root cause
(an 8.2.1 regression in the reports screen on iOS 17.4), and craft an empathetic, concrete reply that offers next
steps and a temporary workaround.`,
  },
  {
    domain: 'data-pipeline',
    a: `Design an idempotent ingestion pipeline for clickstream events delivered as JSON to S3. A sample event:
\`\`\`json
{ "event_id": "e-9f3", "user_id": "u-12", "ts": "2026-03-01T10:02:11Z", "type": "add_to_cart", "sku": "A-77" }
\`\`\`
Events can arrive out of order and be duplicated. Describe dedup keyed on event_id, late-arrival handling with
watermarks, partitioning by date, the schema-evolution strategy, and exactly-once delivery into a warehouse fact
table. Call out where idempotency is enforced.`,
    b: `I need an architecture for ingesting clickstream JSON events that land in S3, and it has to be idempotent.
Here's a representative record:
\`\`\`json
{ "event_id": "e-9f3", "user_id": "u-12", "ts": "2026-03-01T10:02:11Z", "type": "add_to_cart", "sku": "A-77" }
\`\`\`
Because events show up duplicated and out of sequence, explain how you'd deduplicate on event_id, handle
late-arriving data with watermarks, partition by event date, evolve the schema over time, and load into a
warehouse fact table exactly once — and where precisely idempotency gets guaranteed.`,
  },
];

// ─── IR scoring over the threshold sweep ─────────────────────

interface Metrics { threshold: number; tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; f1: number; fpr: number; accuracy: number; hitRate: number }

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }

/** store(A) into a fresh cache, find(B); a "hit" = B retrieved A's stored response. */
async function isHit(a: string, b: string, threshold: number): Promise<boolean> {
  const sentinel = { __r: a.length };
  const sc = weaveSemanticCache({ embed, defaultThreshold: threshold });
  await sc.store(a, sentinel);
  const found = await sc.find(b);
  return found !== null && (found.response as any).__r === sentinel.__r;
}

async function evaluateAt(threshold: number): Promise<Metrics> {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  // Positives: every doc against its own paraphrase (true duplicates).
  for (const d of DOCS) {
    if (await isHit(d.a, d.b, threshold)) tp++; else fn++;
  }
  // Negatives: every doc against the NEXT doc's prompt (unrelated, balanced count).
  for (let i = 0; i < DOCS.length; i++) {
    const other = DOCS[(i + 1) % DOCS.length]!;
    if (await isHit(DOCS[i]!.a, other.a, threshold)) fp++; else tn++;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);
  const accuracy = (tp + tn) / (tp + fp + fn + tn);
  const hitRate = (tp + fp) / (tp + fp + fn + tn);
  return { threshold, tp, fp, fn, tn, precision, recall, f1, fpr, accuracy, hitRate };
}

// ─── The benchmark ───────────────────────────────────────────

describe('semantic cache — app-level retrieval benchmark (long/complex prompts)', () => {
  const SWEEP = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.92, 0.95];

  it('reports precision/recall/F1/FPR across the threshold sweep and meets loose bounds', async () => {
    const rows: Metrics[] = [];
    for (const t of SWEEP) rows.push(await evaluateAt(t));

    // ── Report (this is the deliverable; assertions are intentionally loose) ──
    // eslint-disable-next-line no-console
    console.log(
      `\n  Semantic cache app-benchmark — ${DOCS.length} duplicate + ${DOCS.length} unrelated long/complex pairs\n` +
      '  thr   | prec  | recall|  F1   |  FPR  | hit%  | TP FP FN TN',
    );
    for (const m of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${m.threshold.toFixed(2)}  | ${pct(m.precision).padStart(5)} | ${pct(m.recall).padStart(5)} | ` +
        `${pct(m.f1).padStart(5)} | ${pct(m.fpr).padStart(5)} | ${pct(m.hitRate).padStart(5)} | ` +
        `${m.tp}  ${m.fp}  ${m.fn}  ${m.tn}`,
      );
    }

    const bestF1 = rows.reduce((a, b) => (b.f1 > a.f1 ? b : a));
    const bestPrecision = rows.reduce((a, b) => (b.precision > a.precision ? b : a));
    const bestRecall = rows.reduce((a, b) => (b.recall > a.recall ? b : a));
    // eslint-disable-next-line no-console
    console.log(
      `\n  → best-F1 @ thr ${bestF1.threshold} (F1 ${pct(bestF1.f1)}, P ${pct(bestF1.precision)}, R ${pct(bestF1.recall)})\n` +
      `  → published app-level targets: precision 92–98%, false-positive ≤ ~1% (Spheron/GPTCache/JSAER)\n` +
      `  → our best precision ${pct(bestPrecision.precision)} @ thr ${bestPrecision.threshold}; ` +
      `best recall ${pct(bestRecall.recall)} @ thr ${bestRecall.threshold}\n`,
    );

    // ── Soft assertions (loose — guard the SHAPE, not exact numbers) ──
    expect(rows).toHaveLength(SWEEP.length);
    // The cache can be tuned for trust: some threshold reaches high precision with low false positives.
    expect(bestPrecision.precision).toBeGreaterThanOrEqual(0.85);
    expect(rows.some((m) => m.fpr <= 0.1)).toBe(true);
    // The cache can be tuned for coverage: some threshold recovers most true duplicates.
    expect(bestRecall.recall).toBeGreaterThanOrEqual(0.7);
    // There is a usable operating point at all.
    expect(bestF1.f1).toBeGreaterThanOrEqual(0.6);
  });

  it('recall is monotonically non-increasing as the threshold rises (sanity of the gate)', async () => {
    const recalls: number[] = [];
    for (const t of SWEEP) recalls.push((await evaluateAt(t)).recall);
    for (let i = 1; i < recalls.length; i++) {
      // A stricter cosine threshold can never admit MORE duplicates.
      expect(recalls[i]!).toBeLessThanOrEqual(recalls[i - 1]! + 1e-9);
    }
  });

  it('at the strictest threshold the false-positive rate is low (no unrelated long prompt leaks through)', async () => {
    const strict = await evaluateAt(0.95);
    // Loose ceiling — our toy embedding is looser than a real model, but unrelated long prompts
    // about different domains must not masquerade as hits at a strict threshold.
    expect(strict.fpr).toBeLessThanOrEqual(0.2);
  });
});
