export {
  weaveConsoleTracer,
  weaveInMemoryTracer,
  weaveUsageTracker,
} from './tracer.js';

// Phase 5 extensions
export { weaveBudgetTracker, type BudgetTracker, type BudgetConfig, type BudgetAlert, type BudgetSnapshot } from './budget-tracker.js';
export { weaveTraceGraph, formatTraceGraph, type TraceGraph, type TraceNode } from './trace-graph.js';
export { weaveJsonSink, type JsonSinkConfig } from './json-sink.js';
export { weaveRunTimeline, type RunTimeline, type TimelineEntry } from './run-timeline.js';
