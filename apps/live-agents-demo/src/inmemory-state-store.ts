import {
  weaveInMemoryStateStore,
  type StateStore,
} from '@weaveintel/live-agents';

export interface InMemoryDemoStateStore extends StateStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export async function createInMemoryDemoStateStore(): Promise<InMemoryDemoStateStore> {
  const stateStore = weaveInMemoryStateStore();
  return {
    ...stateStore,
    async initialize() {
      return;
    },
    async close() {
      return;
    },
  };
}
