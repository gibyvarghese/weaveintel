import {
  contractFromRecord,
  InMemoryContractRegistry,
  validateContract,
  type ContractValidationResult,
} from '@weaveintel/prompts';
import type { DatabaseAdapter } from './db.js';

interface PromptContractCheckResult {
  key: string;
  name: string;
  contractType: string;
  valid: boolean;
  severity: ContractValidationResult['severity'];
  message: string;
  errorCount: number;
  repairSuggestion?: string;
}

interface PromptContractValidationSummary {
  total: number;
  passed: number;
  failed: number;
  error: number;
  warning: number;
  info: number;
}

export interface PromptContractValidationReport {
  summary: PromptContractValidationSummary;
  results: PromptContractCheckResult[];
}

export async function validatePromptContractsAgainstDb(
  output: string,
  db: DatabaseAdapter,
): Promise<PromptContractValidationReport | undefined> {
  if (!output.trim()) return undefined;
  try {
    const rows = await db.listPromptContracts();
    const enabledRows = rows.filter((row) => row.enabled);
    if (enabledRows.length === 0) return undefined;

    const parsed = enabledRows
      .map((row) => ({
        row,
        contract: contractFromRecord({
          id: row.id,
          key: row.key,
          name: row.name,
          description: row.description ?? '',
          contract_type: row.contract_type,
          schema: row.schema ?? undefined,
          config: row.config,
          enabled: row.enabled,
        }),
      }))
      .filter((entry): entry is { row: typeof enabledRows[number]; contract: NonNullable<ReturnType<typeof contractFromRecord>> } => !!entry.contract);

    if (parsed.length === 0) return undefined;

    const registry = new InMemoryContractRegistry(parsed.map((entry) => entry.contract));
    const results: PromptContractCheckResult[] = parsed.map(({ row }) => {
      const contract = registry.get(row.key);
      if (!contract) {
        return {
          key: row.key,
          name: row.name,
          contractType: row.contract_type,
          valid: false,
          severity: 'error',
          message: 'Contract could not be loaded from registry',
          errorCount: 1,
        };
      }
      const validation = validateContract(output, contract);
      return {
        key: row.key,
        name: row.name,
        contractType: row.contract_type,
        valid: validation.valid,
        severity: validation.severity,
        message: validation.message,
        errorCount: validation.errors.length,
        repairSuggestion: validation.repairSuggestion,
      };
    });

    const summary: PromptContractValidationSummary = {
      total: results.length,
      passed: results.filter((result) => result.valid).length,
      failed: results.filter((result) => !result.valid).length,
      error: results.filter((result) => result.severity === 'error').length,
      warning: results.filter((result) => result.severity === 'warning').length,
      info: results.filter((result) => result.severity === 'info').length,
    };

    return { summary, results };
  } catch {
    return undefined;
  }
}