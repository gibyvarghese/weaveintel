/**
 * @weaveintel/geneweave — Admin CRUD routes
 *
 * Registers all admin configuration endpoints (prompts, guardrails, routing, etc.)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GuardrailRevisionStore, WeaveRuntime } from '@weaveintel/core';
import type { DatabaseAdapter } from './db.js';
import { validateDetailedDescription } from './admin/api/admin-route-helpers.js';
import {
  registerAdminUserRoutes,
  registerAdminPromptRoutes,
  registerAdminRoutingRoutes,
  registerAdminConnectorRoutes,
  registerAdminCatalogRoutes,
  registerAdminA2ASkillRoutes,
} from './admin/routes/index.js';
import type { RouterLike } from './admin/api/types.js';

export interface AdminRouteExtras {
  guardrailRevisionStore?: GuardrailRevisionStore;
  /** App-wide runtime — carries durable KV so weaveAudit writes persist. */
  runtime?: WeaveRuntime;
}

export function registerAdminRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, data: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<string>,
  providers?: Record<string, { apiKey?: string }>,
  html?: (res: ServerResponse, status: number, body: string) => void,
  extras?: AdminRouteExtras,
): void {
  function requireDetailedDescription(
    description: unknown,
    kind: 'prompt' | 'tool' | 'skill' | 'agent',
    res: ServerResponse,
  ): string | null {
    const validation = validateDetailedDescription(description, kind);
    if (!validation.valid) {
      json(res, 400, { error: validation.error });
      return null;
    }
    return validation.description;
  }
  void requireDetailedDescription; // used by sub-modules via their own local copy

  registerAdminUserRoutes(router, db, json, readBody);
  registerAdminPromptRoutes(router, db, json, readBody);
  registerAdminRoutingRoutes(router, db, json, readBody, providers, extras?.guardrailRevisionStore, extras?.runtime);
  registerAdminConnectorRoutes(router, db, json, readBody, providers, html);
  registerAdminCatalogRoutes(router, db, json, readBody);
  registerAdminA2ASkillRoutes(router, db, json, readBody);
}
