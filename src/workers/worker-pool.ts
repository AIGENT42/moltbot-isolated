/**
 * Worker Pool Manager - Manages worker processes and request routing
 *
 * Responsibilities:
 * - Spawn and manage worker processes
 * - Route requests to workers via sticky routing
 * - Handle worker crashes and restarts
 * - Monitor worker health
 */

import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  type GatewayToWorkerMessageInput,
  GatewayToWorkerMessageType,
  type WorkerToGatewayMessage,
  WorkerToGatewayMessageType,
  createGatewayMessage,
} from "./ipc-protocol.js";
import { StickyRouter } from "./sticky-router.js";
import {
  DEFAULT_WORKER_POOL_CONFIG,
  type UserId,
  type WorkerConfig,
  type WorkerHealth,
  type WorkerId,
  type WorkerPoolConfig,
  type WorkerPoolStatus,
  type WorkerRequest,
  type WorkerResponse,
  WorkerState,
} from "./types.js";
import { SandboxManager } from "./worker-sandbox.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Environment variables that should NOT be passed to worker processes.
 * Workers get isolated credentials via their sandbox paths instead.
 */
const SENSITIVE_ENV_PATTERNS = [
  // API keys and tokens
  /^ANTHROPIC_API_KEY$/i,
  /^OPENAI_API_KEY$/i,
  /^CLAUDE_API_KEY$/i,
  /^DISCORD_TOKEN$/i,
  /^DISCORD_BOT_TOKEN$/i,
  /^TELEGRAM_BOT_TOKEN$/i,
  /^SLACK_BOT_TOKEN$/i,
  /^SLACK_SIGNING_SECRET$/i,
  // OAuth and credentials
  /^CLAWDBOT_OAUTH_DIR$/i, // Will be set by sandbox
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^NPM_TOKEN$/i,
  // Generic sensitive patterns
  /_TOKEN$/i,
  /_SECRET$/i,
  /_API_KEY$/i,
  /_PASSWORD$/i,
  /_PRIVATE_KEY$/i,
];

/**
 * Filter out sensitive environment variables from parent process.
 * Workers get their own isolated credentials via sandbox paths.
 */
function filterSensitiveEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const isSensitive = SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key));
    if (!isSensitive) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/** Worker instance state */
interface WorkerInstance {
  workerId: WorkerId;
  process: ChildProcess | null;
  state: WorkerState;
  health: WorkerHealth | null;
  config: WorkerConfig;
  restartCount: number;
  restartTimes: number[];
  pendingRequests: Map<string, PendingRequest>;
}

/** Pending request tracker */
interface PendingRequest {
  request: WorkerRequest;
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/** Worker pool events */
export interface WorkerPoolEvents {
  "worker:ready": (workerId: WorkerId) => void;
  "worker:crash": (workerId: WorkerId, error: Error) => void;
  "worker:restart": (workerId: WorkerId, attempt: number) => void;
  "worker:stopped": (workerId: WorkerId) => void;
  "request:complete": (requestId: string, duration: number) => void;
  "request:failed": (requestId: string, error: string) => void;
  "pool:ready": () => void;
  "pool:degraded": (healthyCount: number, totalCount: number) => void;
}

/**
 * Worker Pool Manager
 */
export class WorkerPool extends EventEmitter {
  private config: WorkerPoolConfig;
  private workers: Map<WorkerId, WorkerInstance> = new Map();
  private router: StickyRouter;
  private sandboxManager: SandboxManager;
  private started = false;
  private stopping = false;

  constructor(config: Partial<WorkerPoolConfig> = {}) {
    super();
    this.config = { ...DEFAULT_WORKER_POOL_CONFIG, ...config };
    this.router = new StickyRouter();
    this.sandboxManager = new SandboxManager(this.config.sandboxBaseDir);
  }

  /**
   * Start the worker pool
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Worker pool already started");
    }

    console.log(`[WorkerPool] Starting with ${this.config.workerCount} workers`);

    // Initialize sandbox manager
    await this.sandboxManager.initialize();

    // Spawn workers
    const workerIds: WorkerId[] = [];
    for (let i = 0; i < this.config.workerCount; i++) {
      const workerId = `worker-${i}`;
      workerIds.push(workerId);
    }

    // Add workers to router
    for (const workerId of workerIds) {
      this.router.addWorker(workerId);
    }

    // Spawn all workers
    await Promise.all(workerIds.map((id) => this.spawnWorker(id)));

    this.started = true;
    this.emit("pool:ready");
    console.log(`[WorkerPool] All workers ready`);
  }

  /**
   * Stop the worker pool
   */
  async stop(gracePeriod = 5000): Promise<void> {
    if (!this.started || this.stopping) {
      return;
    }

    this.stopping = true;
    console.log(`[WorkerPool] Stopping (grace: ${gracePeriod}ms)`);

    // Send shutdown to all workers
    const shutdownPromises = Array.from(this.workers.values()).map(async (worker) => {
      if (worker.process && worker.state !== WorkerState.Stopped) {
        this.sendToWorker(worker.workerId, {
          type: GatewayToWorkerMessageType.Shutdown,
          gracePeriod,
        });

        // Wait for graceful shutdown or force kill
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (worker.process) {
              worker.process.kill("SIGKILL");
            }
            resolve();
          }, gracePeriod + 1000);

          if (worker.process) {
            worker.process.once("exit", () => {
              clearTimeout(timeout);
              resolve();
            });
          } else {
            clearTimeout(timeout);
            resolve();
          }
        });
      }
    });

    await Promise.all(shutdownPromises);

    this.workers.clear();
    this.started = false;
    this.stopping = false;
    console.log(`[WorkerPool] Stopped`);
  }

  /**
   * Send a request to the appropriate worker
   */
  async sendRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.started) {
      throw new Error("Worker pool not started");
    }

    // Route request to worker
    const decision = this.router.route(request.userId);
    const worker = this.workers.get(decision.workerId);

    if (!worker) {
      throw new Error(`Worker ${decision.workerId} not found`);
    }

    if (worker.state !== WorkerState.Ready && worker.state !== WorkerState.Busy) {
      // Try to find an alternative healthy worker
      const healthyWorker = this.findHealthyWorker();
      if (!healthyWorker) {
        throw new Error("No healthy workers available");
      }
      // Force assign this user to the healthy worker temporarily
      this.router.forceAssign(request.userId, healthyWorker.workerId);
      return this.sendRequestToWorker(healthyWorker, request);
    }

    return this.sendRequestToWorker(worker, request);
  }

  /**
   * Send request to a specific worker
   */
  private sendRequestToWorker(
    worker: WorkerInstance,
    request: WorkerRequest,
  ): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.pendingRequests.delete(request.requestId);
        reject(new Error(`Request ${request.requestId} timed out`));
      }, request.timeout ?? this.config.workerConfig.requestTimeout);

      worker.pendingRequests.set(request.requestId, {
        request,
        resolve,
        reject,
        timeout,
      });

      this.sendToWorker(worker.workerId, {
        type: GatewayToWorkerMessageType.Request,
        request,
      });
    });
  }

  /**
   * Find a healthy worker
   */
  private findHealthyWorker(): WorkerInstance | null {
    for (const worker of this.workers.values()) {
      if (worker.state === WorkerState.Ready || worker.state === WorkerState.Busy) {
        return worker;
      }
    }
    return null;
  }

  /**
   * Get worker for a user (without sending a request)
   */
  getWorkerForUser(userId: UserId): WorkerId | null {
    return this.router.peek(userId);
  }

  /**
   * Get pool status
   */
  getStatus(): WorkerPoolStatus {
    const workers = Array.from(this.workers.values()).map(
      (w) =>
        w.health ?? {
          workerId: w.workerId,
          state: w.state,
          pid: w.process?.pid ?? null,
          requestsProcessed: 0,
          activeRequests: w.pendingRequests.size,
          lastHeartbeat: 0,
          memoryUsage: 0,
          cpuUsage: 0,
          uptime: 0,
          errorCount: 0,
        },
    );

    const healthyWorkers = workers.filter(
      (w) => w.state === WorkerState.Ready || w.state === WorkerState.Busy,
    ).length;

    const busyWorkers = workers.filter((w) => w.state === WorkerState.Busy).length;

    const queuedRequests = Array.from(this.workers.values()).reduce(
      (sum, w) => sum + w.pendingRequests.size,
      0,
    );

    return {
      totalWorkers: this.workers.size,
      healthyWorkers,
      busyWorkers,
      queuedRequests,
      workers,
      routingTableSize: this.router.routingTableSize,
    };
  }

  /**
   * Spawn a worker process
   */
  private async spawnWorker(workerId: WorkerId): Promise<void> {
    const sandbox = await this.sandboxManager.getSandbox(workerId);

    // Get instance keys (generated during sandbox.initialize())
    const instanceKeys = await sandbox.getInstanceKeys();

    const config: WorkerConfig = {
      workerId,
      sandboxRoot: sandbox.paths.root,
      instanceId: instanceKeys.instanceId,
      keyFingerprint: instanceKeys.fingerprint,
      ...this.config.workerConfig,
    };

    const worker: WorkerInstance = {
      workerId,
      process: null,
      state: WorkerState.Starting,
      health: null,
      config,
      restartCount: 0,
      restartTimes: [],
      pendingRequests: new Map(),
    };

    this.workers.set(workerId, worker);

    // Spawn the child process with filtered environment
    const workerPath = join(__dirname, "worker-process.js");
    const child = fork(workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...filterSensitiveEnv(process.env),
        ...sandbox.getEnvironment(),
      },
    });

    worker.process = child;

    // Pipe stdout/stderr
    child.stdout?.on("data", (data) => {
      console.log(`[${workerId}] ${data.toString().trim()}`);
    });

    child.stderr?.on("data", (data) => {
      console.error(`[${workerId}] ${data.toString().trim()}`);
    });

    // Handle messages from worker
    child.on("message", (msg: WorkerToGatewayMessage) => {
      this.handleWorkerMessage(workerId, msg);
    });

    // Handle worker exit
    child.on("exit", (code, signal) => {
      this.handleWorkerExit(workerId, code, signal);
    });

    child.on("error", (error) => {
      console.error(`[${workerId}] Process error:`, error);
      worker.state = WorkerState.Crashed;
      this.emit("worker:crash", workerId, error);
    });

    // Send init message
    this.sendToWorker(workerId, {
      type: GatewayToWorkerMessageType.Init,
      config,
    });

    // Wait for ready
    await this.waitForWorkerReady(workerId);
  }

  /**
   * Wait for worker to be ready
   */
  private waitForWorkerReady(workerId: WorkerId): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Worker ${workerId} failed to start`));
      }, 30000);

      const checkReady = () => {
        const worker = this.workers.get(workerId);
        if (worker?.state === WorkerState.Ready) {
          clearTimeout(timeout);
          resolve();
        } else if (worker?.state === WorkerState.Crashed) {
          clearTimeout(timeout);
          reject(new Error(`Worker ${workerId} crashed during startup`));
        }
      };

      // Check periodically
      const interval = setInterval(() => {
        checkReady();
        if (this.workers.get(workerId)?.state === WorkerState.Ready) {
          clearInterval(interval);
        }
      }, 100);
    });
  }

  /**
   * Handle message from worker
   */
  private handleWorkerMessage(workerId: WorkerId, msg: WorkerToGatewayMessage): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    switch (msg.type) {
      case WorkerToGatewayMessageType.Ready:
        worker.state = WorkerState.Ready;
        this.emit("worker:ready", workerId);
        break;

      case WorkerToGatewayMessageType.Response:
        this.handleResponse(worker, msg.response);
        break;

      case WorkerToGatewayMessageType.Health:
        worker.health = msg.health;
        worker.state = msg.health.state;
        break;

      case WorkerToGatewayMessageType.Heartbeat:
        if (worker.health) {
          Object.assign(worker.health, msg.health);
        }
        worker.health = {
          ...worker.health,
          ...msg.health,
          workerId,
        } as WorkerHealth;
        break;

      case WorkerToGatewayMessageType.Error:
        console.error(`[${workerId}] Error:`, msg.error);
        if (msg.fatal) {
          worker.state = WorkerState.Crashed;
        }
        break;

      case WorkerToGatewayMessageType.Event:
        // Handle events
        if (msg.event.type === "stopped") {
          worker.state = WorkerState.Stopped;
          this.emit("worker:stopped", workerId);
        }
        break;
    }
  }

  /**
   * Handle response from worker
   */
  private handleResponse(worker: WorkerInstance, response: WorkerResponse): void {
    const pending = worker.pendingRequests.get(response.requestId);
    if (!pending) {
      console.warn(`[${worker.workerId}] Unknown response: ${response.requestId}`);
      return;
    }

    clearTimeout(pending.timeout);
    worker.pendingRequests.delete(response.requestId);

    if (response.success) {
      this.emit("request:complete", response.requestId, response.duration);
      pending.resolve(response);
    } else {
      this.emit("request:failed", response.requestId, response.error ?? "Unknown");
      pending.reject(new Error(response.error ?? "Request failed"));
    }
  }

  /**
   * Handle worker exit
   */
  private handleWorkerExit(workerId: WorkerId, code: number | null, signal: string | null): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    console.log(`[${workerId}] Exited (code: ${code}, signal: ${signal})`);

    // Reject all pending requests
    for (const [requestId, pending] of worker.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Worker ${workerId} exited`));
    }
    worker.pendingRequests.clear();

    worker.process = null;
    worker.state = WorkerState.Stopped;

    // Don't restart if we're stopping
    if (this.stopping) {
      return;
    }

    // Check if we should restart
    const now = Date.now();
    worker.restartTimes = worker.restartTimes.filter((t) => now - t < this.config.restartWindow);

    if (worker.restartTimes.length >= this.config.maxRestartAttempts) {
      console.error(`[${workerId}] Too many restarts, not restarting`);
      worker.state = WorkerState.Crashed;
      this.emit("worker:crash", workerId, new Error("Too many restarts"));
      this.checkPoolHealth();
      return;
    }

    // Schedule restart
    worker.restartCount++;
    worker.restartTimes.push(now);

    setTimeout(async () => {
      if (!this.stopping) {
        console.log(`[${workerId}] Restarting (attempt ${worker.restartCount})`);
        this.emit("worker:restart", workerId, worker.restartCount);
        try {
          await this.spawnWorker(workerId);
        } catch (error) {
          console.error(`[${workerId}] Restart failed:`, error);
        }
      }
    }, this.config.restartDelay);
  }

  /**
   * Send message to worker
   */
  private sendToWorker(workerId: WorkerId, message: GatewayToWorkerMessageInput): void {
    const worker = this.workers.get(workerId);
    if (!worker?.process) {
      throw new Error(`Worker ${workerId} not running`);
    }

    worker.process.send(createGatewayMessage(message));
  }

  /**
   * Check pool health and emit events
   */
  private checkPoolHealth(): void {
    const status = this.getStatus();
    if (status.healthyWorkers < status.totalWorkers) {
      this.emit("pool:degraded", status.healthyWorkers, status.totalWorkers);
    }
  }

  /**
   * Get router for external access
   */
  getRouter(): StickyRouter {
    return this.router;
  }
}

// Type augmentation for EventEmitter
export interface WorkerPool {
  on<K extends keyof WorkerPoolEvents>(event: K, listener: WorkerPoolEvents[K]): this;
  emit<K extends keyof WorkerPoolEvents>(
    event: K,
    ...args: Parameters<WorkerPoolEvents[K]>
  ): boolean;
}
