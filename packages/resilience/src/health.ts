export interface HealthCheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly message?: string;
  readonly durationMs: number;
}

export interface HealthStatus {
  readonly service: string;
  readonly healthy: boolean;
  readonly checks: readonly HealthCheckResult[];
  readonly checkedAt: string;
}

export type HealthCheckFn = () => Promise<{ ok: boolean; message?: string }>;

export interface HealthChecker {
  addCheck(name: string, check: HealthCheckFn): void;
  run(): Promise<HealthStatus>;
  isHealthy(): Promise<boolean>;
  removeCheck(name: string): boolean;
}

export function createHealthChecker(service: string): HealthChecker {
  const checks = new Map<string, HealthCheckFn>();

  return {
    addCheck(name: string, check: HealthCheckFn): void {
      checks.set(name, check);
    },

    async run(): Promise<HealthStatus> {
      const results: HealthCheckResult[] = [];

      for (const [name, check] of checks) {
        const start = Date.now();
        try {
          const result = await check();
          results.push({
            name,
            ok: result.ok,
            message: result.message,
            durationMs: Date.now() - start,
          });
        } catch (err: unknown) {
          results.push({
            name,
            ok: false,
            message: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
          });
        }
      }

      return {
        service,
        healthy: results.every((r) => r.ok),
        checks: results,
        checkedAt: new Date().toISOString(),
      };
    },

    async isHealthy(): Promise<boolean> {
      const status = await this.run();
      return status.healthy;
    },

    removeCheck(name: string): boolean {
      return checks.delete(name);
    },
  };
}
