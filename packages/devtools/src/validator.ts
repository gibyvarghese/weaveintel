/**
 * @weaveintel/devtools — Configuration validator
 *
 * Validate agent, workflow, and runtime configurations before deployment.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: Severity;
  path: string;
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export type ValidatorRule = (
  config: Record<string, unknown>,
  path: string,
) => ValidationIssue[];

/**
 * Create a config validator with composable rules.
 */
export function createValidator(rules: ValidatorRule[]): ConfigValidator {
  return {
    validate(config: Record<string, unknown>): ValidationResult {
      const issues: ValidationIssue[] = [];
      for (const rule of rules) {
        issues.push(...rule(config, ''));
      }
      return {
        valid: issues.filter((i) => i.severity === 'error').length === 0,
        issues,
      };
    },
  };
}

export interface ConfigValidator {
  validate(config: Record<string, unknown>): ValidationResult;
}

// ─── Built-in rules ──────────────────────────────────────────

export function requiredFields(...fields: string[]): ValidatorRule {
  return (config, basePath) => {
    const issues: ValidationIssue[] = [];
    for (const field of fields) {
      if (config[field] === undefined || config[field] === null || config[field] === '') {
        issues.push({
          severity: 'error',
          path: basePath ? `${basePath}.${field}` : field,
          message: `Missing required field: ${field}`,
        });
      }
    }
    return issues;
  };
}

export function maxStepsInRange(min: number, max: number): ValidatorRule {
  return (config, basePath) => {
    const issues: ValidationIssue[] = [];
    const val = config['maxSteps'] as number | undefined;
    if (val !== undefined && (val < min || val > max)) {
      issues.push({
        severity: 'warning',
        path: basePath ? `${basePath}.maxSteps` : 'maxSteps',
        message: `maxSteps (${val}) is outside recommended range [${min}, ${max}]`,
        suggestion: `Set maxSteps between ${min} and ${max} for optimal performance`,
      });
    }
    return issues;
  };
}

export function noEmptyArrays(...fields: string[]): ValidatorRule {
  return (config, basePath) => {
    const issues: ValidationIssue[] = [];
    for (const field of fields) {
      const val = config[field];
      if (Array.isArray(val) && val.length === 0) {
        issues.push({
          severity: 'warning',
          path: basePath ? `${basePath}.${field}` : field,
          message: `Field "${field}" is an empty array`,
          suggestion: `Remove or populate the "${field}" array`,
        });
      }
    }
    return issues;
  };
}

export function validJsonFields(...fields: string[]): ValidatorRule {
  return (config, basePath) => {
    const issues: ValidationIssue[] = [];
    for (const field of fields) {
      const val = config[field];
      if (typeof val === 'string') {
        try {
          JSON.parse(val);
        } catch {
          issues.push({
            severity: 'error',
            path: basePath ? `${basePath}.${field}` : field,
            message: `Field "${field}" contains invalid JSON`,
          });
        }
      }
    }
    return issues;
  };
}

/** Pre-built validator for agent configs. */
export const agentConfigValidator = createValidator([
  requiredFields('name'),
  maxStepsInRange(1, 100),
]);

/** Pre-built validator for workflow configs. */
export const workflowConfigValidator = createValidator([
  requiredFields('name', 'steps', 'entry_step_id'),
  noEmptyArrays('steps'),
]);
