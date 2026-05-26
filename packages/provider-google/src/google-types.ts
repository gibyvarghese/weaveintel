export interface GoogleProviderOptions {
  apiKey?: string;
  /** Override the API base URL (default: https://generativelanguage.googleapis.com/v1beta) */
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
}
