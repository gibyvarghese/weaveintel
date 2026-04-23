# @weaveintel/tools-filewatch

File system watching for live-agents: monitor directories, react to file changes, trigger agent actions.

## Use cases

- **Config hot-reload:** Watch config directory, reload agent instructions on change
- **Data pipeline:** Watch input directory, process files as they arrive
- **Log monitoring:** Watch log directory, alert agent on error patterns
- **Continuous build:** Watch source directory, trigger code review on commits

## Installation

```bash
npm install @weaveintel/tools-filewatch
```

## API

### createFileWatchTool

Create a tool that agents can call to watch files:

```typescript
import { createFileWatchTool } from '@weaveintel/tools-filewatch';

const fileWatchTool = createFileWatchTool({
  basePath: '/data',                    // Root directory
  allowedPatterns: ['*.json', '*.csv'], // Only watch these patterns
});

// Register with agent
const agent = await mesh.spawnAgent('data-processor', {
  tools: [fileWatchTool],
});

// Agent can now call:
await agent.call('WATCH_FILE', {
  path: '/data/uploads',
  pattern: '*.csv',
  action: 'PROCESS_CSV', // What to do when file arrives
});
```

### Event stream

Watch files and stream events to agent:

```typescript
const fileWatchTool = createFileWatchTool({
  basePath: '/data',
  onFileCreated: async (file) => {
    // Automatically trigger agent action
    return new Contract({
      type: 'FILE_CREATED',
      statement: `File: ${file.path}, Size: ${file.size} bytes`,
      evidence: [
        { tool: 'filewatch', result: { path: file.path, timestamp: file.mtime } },
      ],
    });
  },
  onFileModified: async (file) => {
    return new Contract({
      type: 'FILE_MODIFIED',
      statement: `File: ${file.path} updated`,
      evidence: [{ tool: 'filewatch', result: { path: file.path } }],
    });
  },
});
```

### Configuration

```typescript
interface FileWatchConfig {
  basePath: string;                           // Root to watch
  allowedPatterns: string[];                  // Glob patterns (e.g., ['*.json'])
  ignoredPatterns?: string[];                 // Exclusions (e.g., ['.git', 'node_modules'])
  debounceMs?: number;                        // Wait before triggering (default: 500ms)
  maxFileSize?: number;                       // Bytes (skip large files)
  enableContentHash?: boolean;                // Track content changes vs mtime (default: false)
  recursive?: boolean;                        // Watch subdirectories (default: true)
}

const tool = createFileWatchTool({
  basePath: '/data',
  allowedPatterns: ['*.json'],
  ignoredPatterns: ['.git', 'node_modules', '*.tmp'],
  debounceMs: 1000,
  maxFileSize: 10 * 1024 * 1024, // 10 MB
  enableContentHash: true,
  recursive: true,
});
```

### Listing watched files

```typescript
const tool = createFileWatchTool({ ... });

// Get current watches
const watches = tool.listWatches();
// [
//   { id: 'watch-1', path: '/data/uploads', pattern: '*.csv' },
//   { id: 'watch-2', path: '/data/logs', pattern: '*.log' },
// ]

// Get files matching pattern
const files = tool.listFiles('/data/uploads', '*.csv');
// [
//   { path: '/data/uploads/data1.csv', size: 1024, mtime: ... },
//   { path: '/data/uploads/data2.csv', size: 2048, mtime: ... },
// ]
```

### Stopping watches

```typescript
const watchId = 'watch-1';
tool.stopWatch(watchId);

// Or stop all
tool.stopAllWatches();
```

## Integration with StateStore

Persist file watch state across restarts:

```typescript
const fileWatchTool = createFileWatchTool({
  basePath: '/data',
  stateStore, // Persist watch records
  persistKey: 'file-watches',
});

// On app restart, watches are restored from DB
```

## Monitoring

### Metrics

```typescript
const tool = createFileWatchTool({
  basePath: '/data',
  onFileEvent: (event) => {
    metrics.counter('filewatch.event', {
      eventType: event.type,     // 'created', 'modified', 'deleted'
      pattern: event.pattern,
    });
  },
  onError: (error, path) => {
    metrics.counter('filewatch.error', {
      errorType: error.constructor.name,
      path,
    });
  },
});
```

### Logging

```typescript
const tool = createFileWatchTool({
  basePath: '/data',
  logger: console,
  logLevel: 'info', // 'debug' | 'info' | 'warn' | 'error'
});
```

## Examples

### CSV data pipeline

```typescript
import { createFileWatchTool } from '@weaveintel/tools-filewatch';

const csvWatcher = createFileWatchTool({
  basePath: '/data/uploads',
  allowedPatterns: ['*.csv'],
  onFileCreated: async (file) => {
    return new Contract({
      type: 'CSV_UPLOAD',
      statement: `New CSV: ${file.path}`,
      evidence: [
        { tool: 'filewatch', result: { path: file.path, size: file.size } },
      ],
    });
  },
});

const agent = await mesh.spawnAgent('csv-processor', {
  tools: [csvWatcher],
  instructions: `
When CSV_UPLOAD event arrives:
1. Read the CSV file
2. Validate column headers
3. Transform data
4. Save to database
5. Notify team
  `,
});

// Files dropped in /data/uploads automatically trigger agent
```

### Log monitoring

```typescript
const logWatcher = createFileWatchTool({
  basePath: '/var/log',
  allowedPatterns: ['*.log'],
  ignoredPatterns: ['*.gz', 'archived/**'],
  enableContentHash: true, // Track content changes
  onFileModified: async (file) => {
    // Read last N lines
    const tail = await readFileTail(file.path, 10);
    
    // Check for errors
    const hasError = tail.some(line => line.includes('ERROR') || line.includes('FATAL'));
    
    if (hasError) {
      return new Contract({
        type: 'LOG_ERROR_DETECTED',
        statement: `Error in ${file.path}`,
        evidence: [
          { tool: 'filewatch', result: { lastLines: tail } },
        ],
      });
    }
    return null; // Don't alert if no error
  },
});

const alertAgent = await mesh.spawnAgent('log-monitor', {
  tools: [logWatcher],
  instructions: `
When LOG_ERROR_DETECTED event arrives:
1. Parse the error details
2. Check historical patterns
3. Determine severity
4. Alert team if critical
  `,
});
```

### Config hot-reload

```typescript
const configWatcher = createFileWatchTool({
  basePath: '/etc/app',
  allowedPatterns: ['config.json', 'rules.yaml'],
  debounceMs: 2000, // Wait 2 seconds for file to stabilize
  onFileModified: async (file) => {
    return new Contract({
      type: 'CONFIG_UPDATED',
      statement: `Config file updated: ${file.path}`,
      evidence: [
        { tool: 'filewatch', result: { path: file.path } },
      ],
    });
  },
});

const agent = await mesh.spawnAgent('config-manager', {
  tools: [configWatcher],
  instructions: `
When CONFIG_UPDATED event arrives:
1. Load the new config file
2. Validate it (JSON schema, YAML syntax)
3. Compare to previous config
4. Log the changes
5. Notify if breaking changes detected
  `,
});
```

## Testing

### Mock file system

```typescript
import { createMockFileWatcher } from '@weaveintel/tools-filewatch/testing';

const mockWatcher = createMockFileWatcher({
  basePath: '/data',
});

// Simulate file creation
await mockWatcher.emitFileCreated({
  path: '/data/test.csv',
  size: 1024,
  mtime: new Date(),
});

// Verify agent received event
const messages = await stateStore.loadMessages(agent.id);
expect(messages).toHaveLength(1);
expect(messages[0].contract.type).toBe('CSV_UPLOAD');
```

## Performance

### Large directories

For directories with 1000s of files:

```typescript
const tool = createFileWatchTool({
  basePath: '/data',
  allowedPatterns: ['*.csv'], // Filter early
  debounceMs: 2000,           // Longer debounce
  cacheSize: 10000,           // Keep LRU cache of recent files
});

// Avoid watching entire /data; use specific subdirectories
// Reason: Reduces filesystem watcher overhead
```

### Content hashing (avoid unless needed)

```typescript
const tool = createFileWatchTool({
  basePath: '/data',
  enableContentHash: true, // Expensive: reads file to hash content
  // Use only if distinguishing "file updated but same content" is important
});
```

## Security

- Validate `allowedPatterns` (prevent ../ escapes)
- Set `maxFileSize` to prevent memory exhaustion
- Use `ignoredPatterns` to exclude sensitive directories
- Log all file events for audit trail

## Related

- [@weaveintel/live-agents](../live-agents/README.md) — Core framework
- [@weaveintel/tools-webhook](../tools-webhook/README.md) — Webhook integration
- [Use Cases](../../docs/live-agents/use-cases.md) — File watching examples
