/**
 * Workers CLI - Commands for managing worker pool with sticky routing
 */

import { createServer, type Server } from "node:http";
import type { Command } from "commander";
import {
  createGatewayRouter,
  type GatewayRouter,
  type WorkerPoolStatus,
} from "../workers/index.js";

/** Format bytes to human readable */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
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
    case "ready":
      return "\x1b[32mready\x1b[0m"; // green
    case "busy":
      return "\x1b[33mbusy\x1b[0m"; // yellow
    case "starting":
      return "\x1b[36mstarting\x1b[0m"; // cyan
    case "stopping":
      return "\x1b[33mstopping\x1b[0m"; // yellow
    case "stopped":
      return "\x1b[90mstopped\x1b[0m"; // gray
    case "crashed":
      return "\x1b[31mcrashed\x1b[0m"; // red
    default:
      return state;
  }
}

/** Create dev HTTP server for workers status/health */
function createDevServer(router: GatewayRouter, port: number): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // Health check endpoint
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      const status = router.getStatus();
      const healthy = status && status.healthyWorkers > 0;
      res.statusCode = healthy ? 200 : 503;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          ok: healthy,
          workers: status?.healthyWorkers ?? 0,
          total: status?.totalWorkers ?? 0,
        }),
      );
      return;
    }

    // Status endpoint
    if (url.pathname === "/status") {
      const status = router.getStatus();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    // Ready check (for Kubernetes-style readiness probes)
    if (url.pathname === "/ready" || url.pathname === "/readyz") {
      const status = router.getStatus();
      const ready = status && status.healthyWorkers >= status.totalWorkers;
      res.statusCode = ready ? 200 : 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ready }));
      return;
    }

    // Root shows available endpoints
    if (url.pathname === "/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          endpoints: {
            "/health": "Health check (200 if any worker healthy)",
            "/ready": "Readiness check (200 if all workers ready)",
            "/status": "Full worker pool status",
          },
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("Not Found");
  });

  return server;
}

/** Print worker pool status */
function printStatus(status: WorkerPoolStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log("\n\x1b[1mWorker Pool Status\x1b[0m");
  console.log("─".repeat(50));
  console.log(`Total workers:    ${status.totalWorkers}`);
  console.log(`Healthy workers:  ${status.healthyWorkers}`);
  console.log(`Busy workers:     ${status.busyWorkers}`);
  console.log(`Queued requests:  ${status.queuedRequests}`);
  console.log(`Routing table:    ${status.routingTableSize} entries`);
  console.log("");

  console.log("\x1b[1mWorkers\x1b[0m");
  console.log("─".repeat(50));
  console.log("ID              State      PID     Memory     Requests   Uptime");

  for (const worker of status.workers) {
    const id = worker.workerId.padEnd(15);
    const state = formatState(worker.state).padEnd(18); // Extra padding for ANSI codes
    const pid = (worker.pid?.toString() ?? "-").padStart(7);
    const memory = formatBytes(worker.memoryUsage).padStart(10);
    const requests = worker.requestsProcessed.toString().padStart(10);
    const uptime = formatDuration(worker.uptime).padStart(10);
    console.log(`${id} ${state} ${pid} ${memory} ${requests} ${uptime}`);
  }
  console.log("");
}

/** Demo: run worker pool */
async function runDemo(opts: {
  workers: number;
  sandboxDir: string;
  timeout: number;
  devPort: number;
  bind: string;
}): Promise<void> {
  console.log("\x1b[1mStarting Worker Pool Demo\x1b[0m");
  console.log(`Workers: ${opts.workers}`);
  console.log(`Sandbox: ${opts.sandboxDir}`);
  if (opts.devPort > 0) {
    console.log(`Dev port: ${opts.devPort} (bind: ${opts.bind})`);
  }
  console.log("");

  const router = createGatewayRouter({
    poolConfig: {
      workerCount: opts.workers,
      sandboxBaseDir: opts.sandboxDir,
    },
  });

  console.log("Starting worker pool...");
  await router.start();

  // Start dev server if port specified
  let devServer: Server | null = null;
  if (opts.devPort > 0) {
    devServer = createDevServer(router, opts.devPort);
    await new Promise<void>((resolve, reject) => {
      devServer!.once("error", reject);
      devServer!.listen(opts.devPort, opts.bind, () => {
        console.log(`\x1b[32m✓\x1b[0m Dev server listening on http://${opts.bind}:${opts.devPort}`);
        console.log(`  Health: http://${opts.bind}:${opts.devPort}/health`);
        console.log(`  Status: http://${opts.bind}:${opts.devPort}/status`);
        resolve();
      });
    });
  }

  const status = router.getStatus();
  if (status) {
    printStatus(status, false);
  }

  // Send some test requests
  console.log("\x1b[1mSending test requests...\x1b[0m");
  const testUsers = ["user-1", "user-2", "user-3", "user-4", "user-5"];

  for (const userId of testUsers) {
    const response = await router.route({
      type: "agent",
      userId,
      payload: { message: `Hello from ${userId}` },
    });

    const workerId = router.getWorkerForUser(userId);
    console.log(
      `${userId} → ${workerId}: ${response.success ? "OK" : "FAILED"} (${response.duration}ms)`,
    );
  }

  // Show final status
  console.log("");
  const finalStatus = router.getStatus();
  if (finalStatus) {
    printStatus(finalStatus, false);
  }

  // Show routing table
  console.log("\x1b[1mRouting Assignments\x1b[0m");
  console.log("─".repeat(50));
  for (const userId of testUsers) {
    const workerId = router.getWorkerForUser(userId);
    console.log(`${userId.padEnd(20)} → ${workerId}`);
  }

  // Keep running or stop based on timeout
  if (opts.timeout > 0) {
    console.log(`\nRunning for ${opts.timeout}ms...`);
    await new Promise((resolve) => setTimeout(resolve, opts.timeout));
  } else {
    console.log("\nPress Ctrl+C to stop...");
    await new Promise((resolve) => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    });
  }

  console.log("\nStopping worker pool...");
  if (devServer) {
    devServer.close();
  }
  await router.stop();
  console.log("Done.");
}

/**
 * Register workers CLI commands
 */
export function registerWorkersCli(program: Command): void {
  const workers = program.command("workers").description("Manage worker pool with sticky routing");

  workers
    .command("demo")
    .description("Run a demo of the worker pool")
    .option("-w, --workers <count>", "Number of workers", "4")
    .option("-s, --sandbox-dir <dir>", "Sandbox base directory", "/tmp/moltbot-workers")
    .option("-t, --timeout <ms>", "Run duration (0 = indefinite)", "0")
    .option(
      "-p, --dev-port <port>",
      "Dev server port for health/status endpoints (0 = disabled)",
      "0",
    )
    .option("-b, --bind <host>", "Dev server bind address", "0.0.0.0")
    .action(async (opts) => {
      try {
        await runDemo({
          workers: parseInt(opts.workers, 10),
          sandboxDir: opts.sandboxDir,
          timeout: parseInt(opts.timeout, 10),
          devPort: parseInt(opts.devPort, 10),
          bind: opts.bind,
        });
      } catch (error) {
        console.error("Error:", error);
        process.exit(1);
      }
    });

  workers
    .command("status")
    .description("Show worker pool status")
    .option("--json", "Output as JSON", false)
    .action(async (_opts) => {
      // This would connect to running gateway to get status
      // For now, show a placeholder
      console.log("Worker pool status requires a running gateway with workers enabled.");
      console.log('Use "moltbot workers demo" to test the worker pool.');
    });

  workers
    .command("route")
    .description("Show which worker handles a user ID")
    .argument("<userId>", "User ID to check")
    .action(async (userId) => {
      // This would connect to running gateway to check routing
      console.log(`Routing check for: ${userId}`);
      console.log("This requires a running gateway with workers enabled.");
    });

  workers
    .command("info")
    .description("Show worker pool architecture documentation")
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
• Workers communicate via IPC (no ports per worker)
• Dev port available for health/status monitoring
• Each worker has isolated filesystem/state
• No shared mutable state between workers
• Worker crashes don't affect others
• Safe horizontal scaling on one server

\x1b[1mConfiguration:\x1b[0m
  gateway.workers.enabled: true
  gateway.workers.count: 4
  gateway.workers.sandboxDir: /var/moltbot/workers

\x1b[1mDev Port:\x1b[0m
  Use --dev-port to expose health/status endpoints:
  moltbot workers demo --dev-port 18792

  Endpoints:
    /health   - Health check (200 if any worker healthy)
    /ready    - Readiness check (200 if all workers ready)
    /status   - Full worker pool status (JSON)

\x1b[1mDocker:\x1b[0m
  Environment variables:
    CLAWDBOT_WORKERS_COUNT     Number of workers (default: 4)
    CLAWDBOT_WORKERS_DEV_PORT  Dev server port (default: 18792)
    CLAWDBOT_WORKERS_DIR       Workers sandbox directory

\x1b[1mCommands:\x1b[0m
  moltbot workers demo      Run a demo of the worker pool
  moltbot workers status    Show worker pool status
  moltbot workers route     Check routing for a user ID
`);
    });
}
