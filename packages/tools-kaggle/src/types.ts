/**
 * Shared shapes returned by the Kaggle adapter and MCP tools.
 * Field names mirror Kaggle's REST responses but are normalized to camelCase.
 */

export interface KaggleCompetition {
  id: string;                  // Kaggle competition ref/slug
  title: string;
  url: string;
  category: string | null;
  deadline: string | null;     // ISO 8601
  reward: string | null;
  evaluationMetric: string | null;
  teamCount: number | null;
  userHasEntered: boolean | null;
  description: string | null;
}

export interface KaggleCompetitionFile {
  ref: string;
  name: string;
  size: number;
  creationDate: string | null;
}

export interface KaggleLeaderboardEntry {
  teamId: string;
  teamName: string;
  rank: number;
  score: number | null;
  submissionDate: string | null;
}

export interface KaggleSubmission {
  ref: string;
  fileName: string | null;
  date: string | null;
  description: string | null;
  status: string | null;        // pending | complete | error
  publicScore: number | null;
  privateScore: number | null;
}

export interface KaggleDataset {
  ref: string;                  // owner/slug
  title: string;
  url: string;
  ownerName: string;
  totalBytes: number | null;
  lastUpdated: string | null;
  downloadCount: number | null;
}

export interface KaggleDatasetFile {
  ref: string;
  name: string;
  size: number;
  creationDate: string | null;
}

export interface KaggleKernel {
  ref: string;                  // owner/slug
  title: string;
  url: string;
  author: string;
  language: string | null;      // python | r | sqlite | julia
  kernelType: string | null;    // script | notebook
  lastRunTime: string | null;
  totalVotes: number | null;
}

export interface KaggleKernelOutput {
  ref: string;
  files: Array<{ fileName: string; size: number; url: string }>;
  log: string | null;
}

// ─── Phase K2: write tools ───────────────────────────────────

export interface KaggleSubmitInput {
  /** Competition ref/slug. */
  competitionRef: string;
  /** Raw submission file content (CSV expected; binary not supported in K2). */
  fileContent: string;
  /** Submission file name as shown on Kaggle. */
  fileName: string;
  /** Free-text description shown alongside the submission. */
  description: string;
}

export interface KaggleSubmitResult {
  competitionRef: string;
  /** Submission identifier returned by Kaggle (numeric or short ref). */
  submissionId: string;
  /** Initial server-reported status. Usually 'pending'. */
  status: string;
  /** Public score if Kaggle scored synchronously. Usually null on submit. */
  publicScore: number | null;
  message: string | null;
}

export interface KaggleKernelPushInput {
  /** Kernel slug to create or update. owner/slug; owner is inferred from credentials when omitted. */
  slug: string;
  /** Kernel title. */
  title: string;
  /** Kernel source (notebook JSON or script source). */
  source: string;
  /** notebook | script. */
  kernelType: 'notebook' | 'script';
  /** python | r. Default python. */
  language?: 'python' | 'r';
  /**
   * Whether the kernel is private. Default true (safe-by-default per the
   * tool platform's external-side-effect policy).
   */
  isPrivate?: boolean;
  /** Optional dataset refs to attach (owner/slug). */
  datasetSources?: string[];
  /** Optional competition ref for competition-attached kernels. */
  competitionSource?: string;
  /** Optional kernel refs to attach as "kernel sources". */
  kernelSources?: string[];
  /** Whether to enable internet inside the kernel. Default false. */
  enableInternet?: boolean;
  /** Whether to enable a GPU. Default false. */
  enableGpu?: boolean;
}

export interface KaggleKernelPushResult {
  ref: string;
  versionNumber: number | null;
  url: string;
  status: string;
  errorMessage: string | null;
}

// ─── Phase K6: discussion bot (deferred, opt-in) ─────────────

export interface KaggleDiscussionPostInput {
  /** Competition ref/slug under which the discussion is created. */
  competitionRef: string;
  /** Discussion title. */
  title: string;
  /** Markdown body. Must be authored by a human or an approved agent draft. */
  body: string;
  /**
   * Optional parent discussion id; when provided this becomes a reply rather
   * than a new top-level post.
   */
  parentTopicId?: string;
}

export interface KaggleDiscussionPostResult {
  competitionRef: string;
  /** Kaggle discussion topic id returned by the API. */
  topicId: string;
  url: string;
  status: string;
  message: string | null;
}
