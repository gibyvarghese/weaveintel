/**
 * NotificationTypeRegistry — the catalogue of notification types apps contribute (GAPS G-WI-15).
 *
 * --- For someone new to this ---
 * `NotificationMessage.category` is a closed, coarse grouping (`task`, `run`, `system`…) good for
 * broad filters. A platform with many apps needs finer types: "a change was scheduled for CAB",
 * "a P1 incident was assigned to you". Each app pack registers its types here, keyed
 * `<app>.<module>.<event>` (for example `itsm.change.cab_scheduled`), with:
 *
 *   - the channels it goes to by default,
 *   - per-channel templates,
 *   - its priority and how repeats collapse,
 *   - whether it may be held for a digest, and whether it breaks through quiet hours,
 *   - the permission a person needs to see what it is about (rechecked at send time).
 *
 * The type travels on every notification as `data.type_key`, next to the coarse category, so the
 * dispatcher and preference rules can act on it. Registration refuses anything ambiguous: a
 * malformed key, a duplicate, no channels, a template for a channel the type doesn't use, or a
 * type that is both digestable and breakthrough.
 */

import type { NotificationCategory, NotificationMessage } from '@weaveintel/core';

/** `data` key that carries the type on every notification built from the registry. */
export const TYPE_KEY_FIELD = 'type_key';

/** A per-channel template. `{{name}}` placeholders are filled from the build variables. */
export interface NotificationTemplate {
  readonly title: string;
  readonly body?: string;
}

/** How repeats of one type are handled on the device and in fan-out. */
export interface NotificationDedupe {
  /**
   * `none`: every notification is shown. `collapse`: a newer one replaces an unread older one
   * with the same collapse key. `dedupe`: a repeat with the same key inside the window is dropped.
   */
  readonly strategy: 'none' | 'collapse' | 'dedupe';
  /** Placeholder template for the key, e.g. `{{recordId}}`. Defaults to the type key. */
  readonly keyTemplate?: string;
  /** For `dedupe`: the window in seconds. */
  readonly windowSeconds?: number;
}

export interface NotificationTypeDefinition {
  /** `<app>.<module>.<event>`: lowercase letters, digits and underscores, three or more parts. */
  readonly key: string;
  /** The coarse, closed category this type belongs to. */
  readonly category: NotificationCategory;
  /** Channel ids it goes to by default (the "Org default" before any preference applies). */
  readonly channels: readonly string[];
  /** Templates by channel id; `default` is used for any channel without its own. */
  readonly templates: { readonly default: NotificationTemplate } & Readonly<Record<string, NotificationTemplate>>;
  readonly priority: 'normal' | 'high';
  readonly dedupe?: NotificationDedupe;
  /** May be held and sent in a digest instead of immediately. */
  readonly digestable: boolean;
  /** Ignores quiet hours and digests (for example a P1 page). */
  readonly breakthrough: boolean;
  /** Permission the recipient needs to see the subject; the dispatcher rechecks it at send time. */
  readonly permission?: string;
  /** Who contributed it (an app or pack key), for the settings UI and audit. */
  readonly owner?: string;
  readonly description?: string;
}

export class NotificationTypeError extends Error {
  constructor(message: string, readonly key: string) {
    super(message);
    this.name = 'NotificationTypeError';
  }
}

export interface NotificationTypeRegistry {
  /** Register a type. Throws `NotificationTypeError` on an invalid or duplicate definition. */
  registerType(def: NotificationTypeDefinition): void;
  get(key: string): NotificationTypeDefinition | undefined;
  has(key: string): boolean;
  /** All types, optionally only those whose key starts with `prefix` (e.g. `itsm.`). */
  list(prefix?: string): readonly NotificationTypeDefinition[];
}

const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/;
const CATEGORIES: ReadonlySet<string> = new Set(['task', 'run', 'reminder', 'system', 'custom']);

function validate(def: NotificationTypeDefinition): void {
  const key = def?.key ?? '';
  const fail = (why: string): never => {
    throw new NotificationTypeError(`Notification type ${JSON.stringify(key)}: ${why}`, key);
  };
  if (!KEY_RE.test(key)) fail('key must be <app>.<module>.<event> in lowercase');
  if (!CATEGORIES.has(def.category)) fail(`unknown category ${JSON.stringify(def.category)}`);
  if (!Array.isArray(def.channels) || def.channels.length === 0) fail('needs at least one default channel');
  if (new Set(def.channels).size !== def.channels.length) fail('lists a channel twice');
  if (!def.templates?.default?.title) fail('needs a default template with a title');
  for (const ch of Object.keys(def.templates)) {
    if (ch !== 'default' && !def.channels.includes(ch)) fail(`has a template for channel '${ch}' it does not use`);
  }
  if (def.priority !== 'normal' && def.priority !== 'high') fail('priority must be normal or high');
  if (def.digestable && def.breakthrough) fail('cannot be both digestable and breakthrough');
  if (def.dedupe?.strategy === 'dedupe' && !(def.dedupe.windowSeconds && def.dedupe.windowSeconds > 0)) {
    fail('dedupe needs a positive windowSeconds');
  }
}

export function createNotificationTypeRegistry(initial: readonly NotificationTypeDefinition[] = []): NotificationTypeRegistry {
  const types = new Map<string, NotificationTypeDefinition>();
  const registry: NotificationTypeRegistry = {
    registerType(def) {
      validate(def);
      if (types.has(def.key)) {
        throw new NotificationTypeError(`Notification type ${JSON.stringify(def.key)} is already registered`, def.key);
      }
      types.set(def.key, Object.freeze({ ...def }));
    },
    get(key) {
      return types.get(key);
    },
    has(key) {
      return types.has(key);
    },
    list(prefix) {
      const all = [...types.values()];
      return prefix ? all.filter((t) => t.key.startsWith(prefix)) : all;
    },
  };
  for (const def of initial) registry.registerType(def);
  return registry;
}

/** Fill `{{name}}` placeholders. A placeholder with no value is an error, never left in the text. */
export function renderTemplate(template: string, vars: Readonly<Record<string, string | number>>, key = ''): string {
  return template.replace(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) {
      throw new NotificationTypeError(`Notification type ${JSON.stringify(key)}: no value for {{${name}}}`, key);
    }
    return String(v);
  });
}

/** The template a channel uses: its own if the type has one, else the default. */
export function templateFor(def: NotificationTypeDefinition, channelId: string): NotificationTemplate {
  return def.templates[channelId] ?? def.templates.default;
}

export interface BuildNotificationInput {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  /** Values for the template placeholders. They are rendered into title/body, not copied into `data`. */
  readonly vars?: Readonly<Record<string, string | number>>;
  /** Render a specific channel's template instead of the default. */
  readonly channelId?: string;
  readonly deepLink?: string;
  readonly actions?: NotificationMessage['actions'];
  /** Extra client data. `type_key` is always set from the type and cannot be overridden. */
  readonly data?: Record<string, unknown>;
}

/**
 * Build a `NotificationMessage` for a registered type: category, priority and collapse key from
 * the type, title and body from its template, and `data.type_key` set.
 *
 * @throws NotificationTypeError for an unknown type or a missing template value.
 */
export function buildNotification(
  registry: NotificationTypeRegistry,
  typeKey: string,
  input: BuildNotificationInput,
): NotificationMessage {
  const def = registry.get(typeKey);
  if (!def) throw new NotificationTypeError(`Notification type ${JSON.stringify(typeKey)} is not registered`, typeKey);
  const vars = input.vars ?? {};
  const tpl = templateFor(def, input.channelId ?? 'default');
  const collapseKey = def.dedupe && def.dedupe.strategy !== 'none'
    ? `${typeKey}:${def.dedupe.keyTemplate ? renderTemplate(def.dedupe.keyTemplate, vars, typeKey) : typeKey}`
    : undefined;
  return {
    id: input.id,
    tenantId: input.tenantId,
    principalId: input.principalId,
    category: def.category,
    title: renderTemplate(tpl.title, vars, typeKey),
    ...(tpl.body ? { body: renderTemplate(tpl.body, vars, typeKey) } : {}),
    ...(input.deepLink ? { deepLink: input.deepLink } : {}),
    ...(input.actions ? { actions: input.actions } : {}),
    data: { ...(input.data ?? {}), [TYPE_KEY_FIELD]: typeKey },
    ...(collapseKey ? { collapseKey } : {}),
    priority: def.priority,
  };
}

/** The type key a notification carries, if any. */
export function typeKeyOf(msg: Pick<NotificationMessage, 'data'>): string | undefined {
  const v = msg.data?.[TYPE_KEY_FIELD];
  return typeof v === 'string' ? v : undefined;
}
