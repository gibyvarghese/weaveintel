/**
 * @weaveintel/prompts — Output Contracts
 *
 * Defines, validates, and adapts reusable contracts for prompt output structure and content.
 * Contracts enforce that LLM responses meet specific quality and format requirements.
 *
 * Contract types supported:
 * - json: JSON schema validation
 * - markdown: Markdown section structure validation
 * - code: Code generation constraints (language, style)
 * - max_length: Maximum token or character count
 * - forbidden_content: Patterns or keywords that must not appear
 * - structured: Composite contract combining multiple rules
 */

import type { JSONSchema7 } from 'json-schema';

/** Severity levels for contract validation failures */
export type ContractSeverity = 'error' | 'warning' | 'info';

/** Contract validation result with detailed failure information */
export interface ContractValidationResult {
  /** Whether the output passes all contract checks */
  valid: boolean;
  /** Severity level of failures (if any) */
  severity: ContractSeverity;
  /** Human-readable validation message */
  message: string;
  /** Specific validation errors for debugging */
  errors: ContractValidationError[];
  /** Suggested repair action if validation failed */
  repairSuggestion?: string;
}

/** Detailed information about a specific validation failure */
export interface ContractValidationError {
  /** What was violated (e.g., "missing_section", "invalid_json", "forbidden_keyword") */
  type: string;
  /** Where in the output the violation occurred */
  location?: string;
  /** Human-readable error description */
  message: string;
  /** Suggested fix if available */
  suggestion?: string;
}

/** Repair/retry configuration for contract validation failures */
export interface ContractRepairHook {
  /** Whether automatic repair is enabled for this failure type */
  enabled: boolean;
  /** Retry strategy: "regenerate" | "patch" | "extract" | "fallback" */
  strategy: 'regenerate' | 'patch' | 'extract' | 'fallback';
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Fallback value if repair exhausts retries */
  fallback?: string;
  /** Custom repair instruction to append to the prompt */
  repairInstruction?: string;
}

/** Base contract definition */
export interface PromptContractBase {
  /** Unique identifier for this contract */
  id: string;
  /** Machine-readable key for lookup */
  key: string;
  /** Display name */
  name: string;
  /** Detailed description for model understanding */
  description: string;
  /** Contract severity level */
  severity: ContractSeverity;
  /** Repair configuration for failures */
  repairHook?: ContractRepairHook;
  /** Whether this contract is enabled */
  enabled: boolean;
}

/** JSON Schema contract – validates output against a JSON schema */
export interface JsonContract extends PromptContractBase {
  type: 'json';
  schema: JSONSchema7;
  /** Whether to allow extra properties not in schema */
  allowExtraProperties?: boolean;
}

/** Markdown contract – enforces markdown section structure */
export interface MarkdownContract extends PromptContractBase {
  type: 'markdown';
  /** Required markdown sections (e.g., ["## Summary", "## Details"]) */
  requiredSections: string[];
  /** Whether sections must be in strict order */
  strictOrder?: boolean;
}

/** Code contract – enforces code generation constraints */
export interface CodeContract extends PromptContractBase {
  type: 'code';
  /** Target language(s) (e.g., "python", "javascript") */
  languages: string[];
  /** Style guide or constraint (e.g., "PEP 8", "Google style") */
  style?: string;
  /** Forbidden syntax or patterns */
  forbidden?: string[];
}

/** Max length contract – enforces output size limits */
export interface MaxLengthContract extends PromptContractBase {
  type: 'max_length';
  /** Maximum length in characters */
  maxCharacters?: number;
  /** Maximum length in tokens (approximate) */
  maxTokens?: number;
  /** Unit for length measurement: "characters" | "tokens" | "lines" | "words" */
  unit?: 'characters' | 'tokens' | 'lines' | 'words';
}

/** Forbidden content contract – forbids specific patterns or keywords */
export interface ForbiddenContentContract extends PromptContractBase {
  type: 'forbidden_content';
  /** Regex patterns that must not appear in output */
  patterns: string[];
  /** Case-sensitive matching */
  caseSensitive?: boolean;
  /** Action on detection: "fail" | "warn" | "redact" */
  action?: 'fail' | 'warn' | 'redact';
}

/** Composite contract combining multiple contract types */
export interface StructuredContract extends PromptContractBase {
  type: 'structured';
  /** Array of contracts to validate in sequence */
  contracts: PromptContract[];
  /** How to combine results: "all_pass" | "any_pass" | "majority_pass" */
  combineWith?: 'all_pass' | 'any_pass' | 'majority_pass';
}

/** Union of all contract types */
export type PromptContract =
  | JsonContract
  | MarkdownContract
  | CodeContract
  | MaxLengthContract
  | ForbiddenContentContract
  | StructuredContract;

/** Contract registry for lookup and application */
export interface ContractRegistry {
  get(key: string): PromptContract | undefined;
  listAll(): PromptContract[];
  hasContract(key: string): boolean;
}

/** In-memory contract registry */
export class InMemoryContractRegistry implements ContractRegistry {
  private readonly contracts: Map<string, PromptContract> = new Map();

  constructor(contracts: PromptContract[] = []) {
    for (const c of contracts) {
      this.contracts.set(c.key, c);
    }
  }

  get(key: string): PromptContract | undefined {
    return this.contracts.get(key);
  }

  listAll(): PromptContract[] {
    return Array.from(this.contracts.values());
  }

  hasContract(key: string): boolean {
    return this.contracts.has(key);
  }
}

/** Validate output against a single contract */
export function validateContract(output: string, contract: PromptContract): ContractValidationResult {
  switch (contract.type) {
    case 'json':
      return validateJsonContract(output, contract);
    case 'markdown':
      return validateMarkdownContract(output, contract);
    case 'code':
      return validateCodeContract(output, contract);
    case 'max_length':
      return validateMaxLengthContract(output, contract);
    case 'forbidden_content':
      return validateForbiddenContentContract(output, contract);
    case 'structured':
      return validateStructuredContract(output, contract);
    default:
      return {
        valid: false,
        severity: 'error',
        message: 'Unknown contract type',
        errors: [{ type: 'unknown_contract', message: 'Contract type is not supported' }],
      };
  }
}

/** Validate JSON output against schema */
function validateJsonContract(output: string, contract: JsonContract): ContractValidationResult {
  try {
    const parsed = JSON.parse(output);
    // Simple schema validation (in production, use ajv or similar)
    const schemaErrors: ContractValidationError[] = [];

    // Check required properties
    if (contract.schema.required && contract.schema.properties) {
      for (const prop of contract.schema.required) {
        if (!(prop in parsed)) {
          schemaErrors.push({
            type: 'missing_required_property',
            location: `root.${prop}`,
            message: `Required property "${prop}" is missing`,
            suggestion: `Add property "${prop}" to the JSON object`,
          });
        }
      }
    }

    // Check for extra properties if not allowed
    if (!contract.allowExtraProperties && contract.schema.properties) {
      const allowed = new Set(Object.keys(contract.schema.properties));
      for (const prop of Object.keys(parsed)) {
        if (!allowed.has(prop)) {
          schemaErrors.push({
            type: 'extra_property',
            location: `root.${prop}`,
            message: `Property "${prop}" is not allowed by schema`,
          });
        }
      }
    }

    if (schemaErrors.length > 0) {
      return {
        valid: false,
        severity: contract.severity,
        message: `JSON validation failed: ${schemaErrors.length} error(s)`,
        errors: schemaErrors,
        repairSuggestion: 'Ensure JSON matches schema. Check for missing required fields and unexpected properties.',
      };
    }

    return {
      valid: true,
      severity: 'info',
      message: 'JSON output is valid',
      errors: [],
    };
  } catch (err) {
    return {
      valid: false,
      severity: 'error',
      message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      errors: [{ type: 'invalid_json', message: `JSON parse error: ${err instanceof Error ? err.message : String(err)}` }],
      repairSuggestion: 'Fix JSON syntax. Ensure all strings are quoted, commas are present, and braces/brackets match.',
    };
  }
}

/** Validate markdown section structure */
function validateMarkdownContract(output: string, contract: MarkdownContract): ContractValidationResult {
  const errors: ContractValidationError[] = [];
  const lines = output.split('\n');
  const foundSections = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line == null) {
      continue;
    }
    for (const section of contract.requiredSections) {
      if (line.trim() === section.trim()) {
        foundSections.set(section, i);
      }
    }
  }

  for (const section of contract.requiredSections) {
    if (!foundSections.has(section)) {
      errors.push({
        type: 'missing_section',
        location: `markdown`,
        message: `Required section "${section}" not found`,
        suggestion: `Add a line with "${section}" in the output`,
      });
    }
  }

  // Check strict order if enabled
  if (contract.strictOrder && foundSections.size === contract.requiredSections.length) {
    const positions = Array.from(foundSections.values());
    for (let i = 1; i < positions.length; i++) {
      const current = positions[i];
      const previous = positions[i - 1];
      if (current == null || previous == null) {
        continue;
      }
      if (current < previous) {
        errors.push({
          type: 'section_order_violation',
          message: `Sections are not in required order`,
          suggestion: `Reorder sections to match: ${contract.requiredSections.join(', ')}`,
        });
        break;
      }
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      severity: contract.severity,
      message: `Markdown validation failed: ${errors.length} error(s)`,
      errors,
      repairSuggestion: `Include all required sections: ${contract.requiredSections.join(', ')}${contract.strictOrder ? ' in that order' : ''}`,
    };
  }

  return {
    valid: true,
    severity: 'info',
    message: 'Markdown structure is valid',
    errors: [],
  };
}

/** Validate code generation constraints */
function validateCodeContract(output: string, contract: CodeContract): ContractValidationResult {
  const errors: ContractValidationError[] = [];

  // Check forbidden patterns
  if (contract.forbidden) {
    for (const pattern of contract.forbidden) {
      const regex = new RegExp(pattern, 'g');
      const matches = output.match(regex);
      if (matches) {
        errors.push({
          type: 'forbidden_syntax',
          message: `Forbidden pattern "${pattern}" found ${matches.length} time(s)`,
          suggestion: `Remove or replace the forbidden syntax: ${pattern}`,
        });
      }
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      severity: contract.severity,
      message: `Code validation failed: ${errors.length} error(s)`,
      errors,
      repairSuggestion: `Regenerate code without forbidden patterns. Allowed languages: ${contract.languages.join(', ')}`,
    };
  }

  return {
    valid: true,
    severity: 'info',
    message: 'Code output is valid',
    errors: [],
  };
}

/** Validate output length constraints */
function validateMaxLengthContract(output: string, contract: MaxLengthContract): ContractValidationResult {
  const errors: ContractValidationError[] = [];

  if (contract.maxCharacters && output.length > contract.maxCharacters) {
    errors.push({
      type: 'exceeds_max_characters',
      message: `Output length ${output.length} exceeds maximum ${contract.maxCharacters} characters`,
      suggestion: `Reduce output to ${contract.maxCharacters} characters or less`,
    });
  }

  // Approximate token count (rough estimate: ~1.3 chars per token for English)
  const approxTokens = Math.ceil(output.length / 1.3);
  if (contract.maxTokens && approxTokens > contract.maxTokens) {
    errors.push({
      type: 'exceeds_max_tokens',
      message: `Estimated tokens ${approxTokens} exceeds maximum ${contract.maxTokens}`,
      suggestion: `Reduce output to approximately ${Math.floor(contract.maxTokens * 1.3)} characters`,
    });
  }

  if (errors.length > 0) {
    return {
      valid: false,
      severity: contract.severity,
      message: `Length validation failed: ${errors.length} error(s)`,
      errors,
      repairSuggestion: `Generate a more concise response within the length limit`,
    };
  }

  return {
    valid: true,
    severity: 'info',
    message: `Output length is valid (${output.length} chars)`,
    errors: [],
  };
}

/** Validate forbidden content patterns */
function validateForbiddenContentContract(output: string, contract: ForbiddenContentContract): ContractValidationResult {
  const errors: ContractValidationError[] = [];

  for (const pattern of contract.patterns) {
    const flags = contract.caseSensitive ? 'g' : 'gi';
    const regex = new RegExp(pattern, flags);
    const matches = output.match(regex);

    if (matches && matches.length > 0) {
      const action = contract.action || 'fail';
      errors.push({
        type: 'forbidden_pattern_found',
        message: `Forbidden pattern "${pattern}" found ${matches.length} time(s)`,
        suggestion: `Remove all instances of the forbidden pattern`,
      });

      // If action is 'warn', don't fail validation
      if (action === 'warn') {
        return {
          valid: true,
          severity: 'warning',
          message: `Warning: forbidden content detected but not blocking`,
          errors,
        };
      }
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      severity: contract.severity,
      message: `Forbidden content validation failed: ${errors.length} error(s)`,
      errors,
      repairSuggestion: `Regenerate response without forbidden content`,
    };
  }

  return {
    valid: true,
    severity: 'info',
    message: 'No forbidden content detected',
    errors: [],
  };
}

/** Validate composite contract */
function validateStructuredContract(output: string, contract: StructuredContract): ContractValidationResult {
  const results = contract.contracts.map(c => validateContract(output, c));
  const combineWith = contract.combineWith ?? 'all_pass';

  let isValid = true;
  const maxSeverity = (['error', 'warning', 'info'] as const).reduce((max, curr) => {
    if (results.some(r => r.severity === curr)) return curr;
    return max;
  }, 'info' as ContractSeverity);

  if (combineWith === 'all_pass') {
    isValid = results.every(r => r.valid);
  } else if (combineWith === 'any_pass') {
    isValid = results.some(r => r.valid);
  } else if (combineWith === 'majority_pass') {
    const passCount = results.filter(r => r.valid).length;
    isValid = passCount > results.length / 2;
  }

  const allErrors = results.flatMap(r => r.errors);

  return {
    valid: isValid,
    severity: isValid ? 'info' : maxSeverity,
    message: isValid
      ? `Structured contract passed (${results.length} sub-contracts)`
      : `Structured contract validation failed (${allErrors.length} error(s))`,
    errors: allErrors,
    repairSuggestion: allErrors[0]?.suggestion ?? 'Regenerate response to meet all contract requirements',
  };
}

/** Convert a contract definition from a database record */
export function contractFromRecord(row: {
  id: string;
  key: string;
  name: string;
  description: string;
  contract_type: string;
  schema?: string;
  config?: string;
  enabled: number;
}): PromptContract | null {
  const type = row.contract_type as any;
  const config = row.config ? JSON.parse(row.config) : {};
  const severity = config.severity ?? 'error';
  const repairHook = config.repairHook ? (config.repairHook as ContractRepairHook) : undefined;

  const base = {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    severity,
    repairHook,
    enabled: row.enabled === 1,
  };

  if (type === 'json' && row.schema) {
    return {
      ...base,
      type: 'json',
      schema: JSON.parse(row.schema),
      allowExtraProperties: config.allowExtraProperties ?? false,
    } as JsonContract;
  }

  if (type === 'markdown') {
    return {
      ...base,
      type: 'markdown',
      requiredSections: config.requiredSections ?? [],
      strictOrder: config.strictOrder ?? false,
    } as MarkdownContract;
  }

  if (type === 'code') {
    return {
      ...base,
      type: 'code',
      languages: config.languages ?? [],
      style: config.style,
      forbidden: config.forbidden,
    } as CodeContract;
  }

  if (type === 'max_length') {
    return {
      ...base,
      type: 'max_length',
      maxCharacters: config.maxCharacters,
      maxTokens: config.maxTokens,
      unit: config.unit ?? 'characters',
    } as MaxLengthContract;
  }

  if (type === 'forbidden_content') {
    return {
      ...base,
      type: 'forbidden_content',
      patterns: config.patterns ?? [],
      caseSensitive: config.caseSensitive ?? false,
      action: config.action ?? 'fail',
    } as ForbiddenContentContract;
  }

  return null;
}
