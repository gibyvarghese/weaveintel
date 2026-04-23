import type { ExecutionContext } from '@weaveintel/core';
import type {
  CompressionMaintainer,
  ExternalEvent,
  ExternalEventHandler,
  Heartbeat,
  LiveAgentsRuntime,
  StateStore,
} from './types.js';
import { NotImplementedLiveAgentsError } from './errors.js';
import { asStateStore } from './state-store.js';

export function createLiveAgentsRuntime(opts?: {
  stateStore?: StateStore;
}): LiveAgentsRuntime {
  return {
    stateStore: asStateStore(opts?.stateStore),
    compressors: new Map(),
  };
}

export function createHeartbeat(_opts: {
  stateStore: StateStore;
  workerId: string;
  concurrency: number;
}): Heartbeat {
  return {
    async tick(_ctx: ExecutionContext) {
      throw new NotImplementedLiveAgentsError('Heartbeat.tick');
    },
    async run(_ctx: ExecutionContext) {
      throw new NotImplementedLiveAgentsError('Heartbeat.run');
    },
    async stop() {
      throw new NotImplementedLiveAgentsError('Heartbeat.stop');
    },
  };
}

export function createCompressionMaintainer(_opts: {
  stateStore: StateStore;
}): CompressionMaintainer {
  return {
    async run(_ctx: ExecutionContext) {
      throw new NotImplementedLiveAgentsError('CompressionMaintainer.run');
    },
    async stop() {
      throw new NotImplementedLiveAgentsError('CompressionMaintainer.stop');
    },
  };
}

export function createExternalEventHandler(opts: {
  stateStore: StateStore;
}): ExternalEventHandler {
  return {
    async process(event: ExternalEvent, _ctx: ExecutionContext) {
      const existing = await opts.stateStore.findExternalEvent(event.accountId, event.sourceType, event.sourceRef);
      if (existing) {
        return { routedMessageCount: existing.producedMessageIds.length };
      }
      await opts.stateStore.saveExternalEvent(event);
      return { routedMessageCount: 0 };
    },
  };
}
