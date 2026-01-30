# Worker Pool Setup Guide

Setup sticky routing with 3 isolated workers for users a, b, c.

## Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Build the Project

```bash
pnpm build
```

### 3. Run Worker Pool Demo

```bash
# Start 3 workers with demo
pnpm moltbot workers demo --workers 3 --sandbox-dir /tmp/moltbot-workers
```

## Architecture

```
┌──────────────────────────────────────────────┐
│              Gateway (:18789)                │
│              (Fixed Port)                    │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│            Sticky Router                     │
│     userId → workerId (consistent hash)      │
│                                              │
│   user-a  ───────►  worker-0                 │
│   user-b  ───────►  worker-1                 │
│   user-c  ───────►  worker-2                 │
└──────────────────────┬───────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
┌────────────┐  ┌────────────┐  ┌────────────┐
│  worker-0  │  │  worker-1  │  │  worker-2  │
│ (user-a)   │  │ (user-b)   │  │ (user-c)   │
├────────────┤  ├────────────┤  ├────────────┤
│ /sessions/ │  │ /sessions/ │  │ /sessions/ │
│ /state/    │  │ /state/    │  │ /state/    │
│ /cache/    │  │ /cache/    │  │ /cache/    │
└────────────┘  └────────────┘  └────────────┘
```

## Programmatic Setup

### Basic Usage

```typescript
import { createGatewayRouter } from './src/workers';

// Create router with 3 workers
const router = createGatewayRouter({
  poolConfig: {
    workerCount: 3,
    sandboxBaseDir: '/tmp/moltbot-workers',
  },
});

// Start the worker pool
await router.start();

// Route requests for users a, b, c
const users = ['user-a', 'user-b', 'user-c'];

for (const userId of users) {
  const response = await router.route({
    type: 'agent',
    userId: userId,
    payload: { message: `Hello from ${userId}` },
  });

  const workerId = router.getWorkerForUser(userId);
  console.log(`${userId} → ${workerId}`);
}

// Output:
// user-a → worker-0
// user-b → worker-1
// user-c → worker-2

// Stop when done
await router.stop();
```

### Check Worker Status

```typescript
const status = router.getStatus();
console.log(status);

// {
//   totalWorkers: 3,
//   healthyWorkers: 3,
//   busyWorkers: 0,
//   queuedRequests: 0,
//   routingTableSize: 3,
//   workers: [
//     { workerId: 'worker-0', state: 'ready', pid: 12345, ... },
//     { workerId: 'worker-1', state: 'ready', pid: 12346, ... },
//     { workerId: 'worker-2', state: 'ready', pid: 12347, ... }
//   ]
// }
```

### Verify Sticky Routing

```typescript
// Same user ALWAYS goes to same worker
for (let i = 0; i < 10; i++) {
  const w = router.getWorkerForUser('user-a');
  console.log(`user-a → ${w}`); // Always same worker!
}
```

## CLI Commands

### Run Demo with 3 Workers

```bash
# Run demo (auto-stops after 5 seconds)
pnpm moltbot workers demo -w 3

# Run indefinitely (Ctrl+C to stop)
pnpm moltbot workers demo -w 3 -t 0

# Custom sandbox directory
pnpm moltbot workers demo -w 3 -s /var/moltbot/workers
```

### Show Architecture Info

```bash
pnpm moltbot workers info
```

## Sandbox Directory Structure

Each worker gets isolated directories:

```
/tmp/moltbot-workers/
├── worker-0/
│   ├── sandbox.json      # Metadata
│   ├── sessions/         # Session storage
│   ├── state/            # Persistent state
│   ├── cache/            # Cache files
│   ├── temp/             # Temporary files
│   └── logs/             # Worker logs
├── worker-1/
│   └── ... (same structure)
└── worker-2/
    └── ... (same structure)
```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `workerCount` | 4 | Number of workers |
| `sandboxBaseDir` | `/tmp/moltbot-workers` | Base directory for sandboxes |
| `maxConcurrent` | 10 | Max concurrent requests per worker |
| `requestTimeout` | 120000 | Request timeout (ms) |
| `heartbeatInterval` | 5000 | Health check interval (ms) |
| `maxMemory` | 512MB | Memory limit before restart |
| `maxRequests` | 10000 | Request limit before restart |
| `restartDelay` | 1000 | Delay before restart (ms) |
| `maxRestartAttempts` | 5 | Max restarts in window |
| `restartWindow` | 60000 | Restart tracking window (ms) |

## Example: Full Setup Script

```typescript
// setup-workers.ts
import { createGatewayRouter } from './src/workers';

async function main() {
  console.log('Starting worker pool with 3 workers...\n');

  const router = createGatewayRouter({
    poolConfig: {
      workerCount: 3,
      sandboxBaseDir: '/tmp/moltbot-workers',
      workerConfig: {
        maxConcurrent: 10,
        requestTimeout: 60000,
        heartbeatInterval: 5000,
        maxMemory: 256 * 1024 * 1024, // 256MB
        maxRequests: 5000,
      },
    },
  });

  await router.start();
  console.log('Worker pool ready!\n');

  // Test routing for users a, b, c
  const users = ['user-a', 'user-b', 'user-c'];

  console.log('Routing assignments:');
  console.log('─'.repeat(30));

  for (const userId of users) {
    const response = await router.route({
      type: 'agent',
      userId,
      payload: { message: 'test' },
    });

    const workerId = router.getWorkerForUser(userId);
    console.log(`  ${userId.padEnd(10)} → ${workerId}`);
  }

  console.log('\nVerifying sticky routing (10 requests each):');
  console.log('─'.repeat(30));

  for (const userId of users) {
    const workers = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const w = router.getWorkerForUser(userId);
      if (w) workers.add(w);
    }
    console.log(`  ${userId.padEnd(10)} → always ${[...workers].join(', ')}`);
  }

  // Show status
  console.log('\nWorker Status:');
  console.log('─'.repeat(30));

  const status = router.getStatus();
  if (status) {
    for (const w of status.workers) {
      console.log(`  ${w.workerId}: ${w.state} (pid: ${w.pid})`);
    }
  }

  // Cleanup
  console.log('\nStopping workers...');
  await router.stop();
  console.log('Done!');
}

main().catch(console.error);
```

Run with:
```bash
bun run setup-workers.ts
```

## Key Guarantees

1. **Sticky Routing**: `user-a` always goes to the same worker
2. **Isolation**: Workers have separate filesystems, no shared state
3. **Crash Safety**: One worker crashing doesn't affect others
4. **Auto-Recovery**: Crashed workers restart automatically
5. **Single Port**: Gateway uses one fixed port (no per-user ports)
