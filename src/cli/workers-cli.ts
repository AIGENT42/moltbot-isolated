/**
 * Workers CLI - Commands for managing worker pool with sticky routing
 */

import type { Command } from 'commander';
import { createGatewayRouter, type WorkerPoolStatus } from '../workers/index.js';

/** Format bytes to human readable */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** Format duration to human readable */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/** Format worker state with color */
function formatState(state: string): string {
  switch (state) {
    case 'ready':
      return '\x1b[32mready\x1b[0m'; // green
    case 'busy':
      return '\x1b[33mbusy\x1b[0m'; // yellow
    case 'starting':
      return '\x1b[36mstarting\x1b[0m'; // cyan
    case 'stopping':
      return '\x1b[33mstopping\x1b[0m'; // yellow
    case 'stopped':
      return '\x1b[90mstopped\x1b[0m'; // gray
    case 'crashed':
      return '\x1b[31mcrashed\x1b[0m'; // red
    default:
      return state;
  }
}

/** Print worker pool status */
function printStatus(status: WorkerPoolStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log('\n\x1b[1mWorker Pool Status\x1b[0m');
  console.log('─'.repeat(50));
  console.log(`Total workers:    ${status.totalWorkers}`);
  console.log(`Healthy workers:  ${status.healthyWorkers}`);
  console.log(`Busy workers:     ${status.busyWorkers}`);
  console.log(`Queued requests:  ${status.queuedRequests}`);
  console.log(`Routing table:    ${status.routingTableSize} entries`);
  console.log('');

  console.log('\x1b[1mWorkers\x1b[0m');
  console.log('─'.repeat(50));
  console.log(
    'ID              State      PID     Memory     Requests   Uptime'
  );

  for (const worker of status.workers) {
    const id = worker.workerId.padEnd(15);
    const state = formatState(worker.state).padEnd(18); // Extra padding for ANSI codes
    const pid = (worker.pid?.toString() ?? '-').padStart(7);
    const memory = formatBytes(worker.memoryUsage).padStart(10);
    const requests = worker.requestsProcessed.toString().padStart(10);
    const uptime = formatDuration(worker.uptime).padStart(10);
    console.log(`${id} ${state} ${pid} ${memory} ${requests} ${uptime}`);
  }
  console.log('');
}

/** Demo: run worker pool */
async function runDemo(opts: {
  workers: number;
  sandboxDir: string;
  timeout: number;
}): Promise<void> {
  console.log('\x1b[1mStarting Worker Pool Demo\x1b[0m');
  console.log(`Workers: ${opts.workers}`);
  console.log(`Sandbox: ${opts.sandboxDir}`);
  console.log('');

  const router = createGatewayRouter({
    poolConfig: {
      workerCount: opts.workers,
      sandboxBaseDir: opts.sandboxDir,
    },
  });

  console.log('Starting worker pool...');
  await router.start();

  const status = router.getStatus();
  if (status) {
    printStatus(status, false);
  }

  // Send some test requests
  console.log('\x1b[1mSending test requests...\x1b[0m');
  const testUsers = ['user-1', 'user-2', 'user-3', 'user-4', 'user-5'];

  for (const userId of testUsers) {
    const response = await router.route({
      type: 'agent',
      userId,
      payload: { message: `Hello from ${userId}` },
    });

    const workerId = router.getWorkerForUser(userId);
    console.log(
      `${userId} → ${workerId}: ${response.success ? 'OK' : 'FAILED'} (${response.duration}ms)`
    );
  }

  // Show final status
  console.log('');
  const finalStatus = router.getStatus();
  if (finalStatus) {
    printStatus(finalStatus, false);
  }

  // Show routing table
  console.log('\x1b[1mRouting Assignments\x1b[0m');
  console.log('─'.repeat(50));
  for (const userId of testUsers) {
    const workerId = router.getWorkerForUser(userId);
    console.log(`${userId.padEnd(20)} → ${workerId}`);
  }

  // Keep running or stop based on timeout
  if (opts.timeout > 0) {
    console.log(`\nRunning for ${opts.timeout}ms...`);
    await new Promise((resolve) => setTimeout(resolve, opts.timeout));
  } else {
    console.log('\nPress Ctrl+C to stop...');
    await new Promise((resolve) => {
      process.on('SIGINT', resolve);
      process.on('SIGTERM', resolve);
    });
  }

  console.log('\nStopping worker pool...');
  await router.stop();
  console.log('Done.');
}

/**
 * Register workers CLI commands
 */
export function registerWorkersCli(program: Command): void {
  const workers = program
    .command('workers')
    .description('Manage worker pool with sticky routing');

  workers
    .command('demo')
    .description('Run a demo of the worker pool')
    .option('-w, --workers <count>', 'Number of workers', '4')
    .option(
      '-s, --sandbox-dir <dir>',
      'Sandbox base directory',
      '/tmp/moltbot-workers'
    )
    .option('-t, --timeout <ms>', 'Run duration (0 = indefinite)', '0')
    .action(async (opts) => {
      try {
        await runDemo({
          workers: parseInt(opts.workers, 10),
          sandboxDir: opts.sandboxDir,
          timeout: parseInt(opts.timeout, 10),
        });
      } catch (error) {
        console.error('Error:', error);
        process.exit(1);
      }
    });

  workers
    .command('status')
    .description('Show worker pool status')
    .option('--json', 'Output as JSON', false)
    .action(async (opts) => {
      // This would connect to running gateway to get status
      // For now, show a placeholder
      console.log(
        'Worker pool status requires a running gateway with workers enabled.'
      );
      console.log('Use "moltbot workers demo" to test the worker pool.');
    });

  workers
    .command('route')
    .description('Show which worker handles a user ID')
    .argument('<userId>', 'User ID to check')
    .action(async (userId) => {
      // This would connect to running gateway to check routing
      console.log(`Routing check for: ${userId}`);
      console.log(
        'This requires a running gateway with workers enabled.'
      );
    });

  workers
    .command('info')
    .description('Show worker pool architecture documentation')
    .action(() => {
      console.log(`
\x1b[1mWorker Pool Architecture\x1b[0m

The worker pool provides sticky routing with isolated sandboxes:

┌─────────────────────────────────────────────────────────┐
│                      Gateway                            │
│                   (Fixed Port)                          │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│                  Gateway Router                         │
│            (Sticky Routing Layer)                       │
│         userId → workerId (consistent hash)             │
└─────────────────────┬───────────────────────────────────┘
                      │
         ┌────────────┼────────────┐
         │            │            │
         ▼            ▼            ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   Worker 0   │ │   Worker 1   │ │   Worker N   │
│  (Isolated)  │ │  (Isolated)  │ │  (Isolated)  │
├──────────────┤ ├──────────────┤ ├──────────────┤
│   Sandbox    │ │   Sandbox    │ │   Sandbox    │
│  /sessions/  │ │  /sessions/  │ │  /sessions/  │
│  /state/     │ │  /state/     │ │  /state/     │
│  /cache/     │ │  /cache/     │ │  /cache/     │
└──────────────┘ └──────────────┘ └──────────────┘

\x1b[1mKey Features:\x1b[0m
• One gateway with fixed port - gateway only routes requests
• Sticky routing: same user always goes to same worker
• Workers don't bind ports - communicate via IPC
• Each worker has isolated filesystem/state
• No shared mutable state between workers
• Worker crashes don't affect others
• Safe horizontal scaling on one server

\x1b[1mConfiguration:\x1b[0m
  gateway.workers.enabled: true
  gateway.workers.count: 4
  gateway.workers.sandboxDir: /var/moltbot/workers

\x1b[1mCommands:\x1b[0m
  moltbot workers demo      Run a demo of the worker pool
  moltbot workers status    Show worker pool status
  moltbot workers route     Check routing for a user ID
`);
    });
}
