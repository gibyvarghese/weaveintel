export type SgPlatform =
  | 'linkedin'
  | 'instagram'
  | 'facebook'
  | 'tiktok'
  | 'medium'
  | 'blogger'
  | 'x'
  | 'youtube';

export interface SgWorkflowContext {
  brandId: string;
  campaignId?: string;
  channelId?: string;
}

export interface SgStepConfig {
  id: string;
  name: string;
  type: 'plan' | 'generate' | 'review' | 'schedule' | 'publish' | 'measure';
  config?: Record<string, unknown>;
}

export interface SgWorkflowTemplate {
  id: string;
  name: string;
  triggerType: 'schedule' | 'webhook' | 'manual' | 'event';
  steps: SgStepConfig[];
}
