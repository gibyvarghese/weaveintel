/**
 * @weaveintel/ui-primitives — Widget renderer registry
 *
 * Interface + in-memory reference implementation for mapping a `WidgetType`
 * to a renderer function.  Actual renderers are app code; the registry is
 * framework infrastructure.
 *
 * The registry enforces a mandatory fallback renderer so clients always have
 * something to render for unknown widget types, satisfying the
 * `WidgetPayload.fallback` contract.
 *
 * Vocabulary rule: "renderer", "surface", "widget" — never "chat" / "message".
 */

import type { WidgetPayload, WidgetType } from '@weaveintel/core';

// ─── Renderer function ────────────────────────────────────────────────────────

/**
 * A renderer takes a widget payload and produces an output of type `T`.
 * `T` is app-defined (e.g. JSX element, HTML string, native view descriptor).
 */
export type WidgetRenderer<T> = (widget: WidgetPayload) => T;

// ─── Registry interface ───────────────────────────────────────────────────────

/**
 * A typed map from `WidgetType` to renderer, with registration, resolution,
 * and a mandatory fallback renderer for unknown types.
 *
 * @typeParam T - The output type of all renderers in this registry.
 */
export interface WidgetRendererRegistry<T> {
  /**
   * Register a renderer for a specific widget type.
   * Overwrites any existing renderer for the same type.
   */
  register(type: WidgetType | string, renderer: WidgetRenderer<T>): void;

  /**
   * Resolve the renderer for `type`.
   * If no renderer is registered for `type`, returns the fallback renderer.
   * Never returns `undefined`.
   */
  resolve(type: WidgetType | string): WidgetRenderer<T>;

  /**
   * Render a widget payload.
   * Equivalent to `registry.resolve(widget.type)(widget)`.
   * Falls back automatically for unknown types.
   */
  render(widget: WidgetPayload): T;
}

// ─── In-memory reference implementation ──────────────────────────────────────

/**
 * Create an in-memory `WidgetRendererRegistry`.
 *
 * @param fallbackRenderer - Renderer used for any type without a registered
 *   handler.  REQUIRED — there is no registry without a fallback.
 */
export function createWidgetRendererRegistry<T>(
  fallbackRenderer: WidgetRenderer<T>,
): WidgetRendererRegistry<T> {
  const renderers = new Map<string, WidgetRenderer<T>>();

  return {
    register(type, renderer) {
      renderers.set(type, renderer);
    },

    resolve(type) {
      return renderers.get(type) ?? fallbackRenderer;
    },

    render(widget) {
      const renderer = renderers.get(widget.type) ?? fallbackRenderer;
      return renderer(widget);
    },
  };
}
