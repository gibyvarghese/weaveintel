import type { AgentResult } from '@weaveintel/core';

export function containsSandboxArtifactPath(text: string): boolean {
  if (!text) return false;
  return /\/workspace\/output\/[^\s)"']+\.png/iu.test(text)
    || /"img_path"\s*:\s*"\/workspace\/output\//iu.test(text);
}

export function indicatesIncompleteAttachmentAnalysis(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('insight summary was blank')
    || lower.includes('summary was blank')
    || lower.includes('would you like me to') && lower.includes('re-run the analysis');
}

export function hasRenderableAttachmentAnalysisOutput(result: AgentResult, goal: string): boolean {
  const output = String(result.output || '').trim();
  if (!output) return false;
  if (containsSandboxArtifactPath(output)) return false;
  if (indicatesIncompleteAttachmentAnalysis(output)) return false;

  const expectsRenderableChart = /\b(chart|charts|graph|graphs|visuali[sz]ation|plot|plots)\b/i.test(goal);
  if (!expectsRenderableChart) return true;

  return output.includes('"chart"')
    || output.includes('```json')
    || !containsSandboxArtifactPath(output);
}
