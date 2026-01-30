/**
 * Worker Process - Runs in a child process and handles requests
 *
 * This is the entry point for worker child processes.
 * It receives requests via IPC, processes them in isolation,
 * and sends responses back to the gateway.
 */

import {
  type GatewayToWorkerMessage,
  GatewayToWorkerMessageType,
  type RequestMessage,
  WorkerToGatewayMessageType,
  createWorkerMessage,
} from './ipc-protocol.js';
import {
  type WorkerConfig,
  type WorkerHealth,
  type WorkerRequest,
  type WorkerResponse,
  WorkerRequestType,
  WorkerState,
} from './types.js';
import { WorkerSandbox } from './worker-sandbox.js';

/** Worker process state */
interface WorkerProcessState {
  config: WorkerConfig | null;
  sandbox: WorkerSandbox | null;
  state: WorkerState;
  requestsProcessed: number;
  activeRequests: Map<string, { request: WorkerRequest; startTime: number }>;
  startTime: number;
  errorCount: number;
  shutdownRequested: boolean;
}

const state: WorkerProcessState = {
  config: null,
  sandbox: null,
  state: WorkerState.Starting,
  requestsProcessed: 0,
  activeRequests: new Map(),
  startTime: Date.now(),
  errorCount: 0,
  shutdownRequested: false,
};

/** Send message to gateway */
function send(
  message: Parameters<typeof createWorkerMessage>[0]
): void {
  if (process.send) {
    process.send(createWorkerMessage(message as any));
  }
}

/** Send heartbeat with health info */
function sendHeartbeat(): void {
  if (!state.config) return;

  const health = getHealth();
  send({
    type: WorkerToGatewayMessageType.Heartbeat,
    workerId: state.config.workerId,
    health: {
      state: health.state,
      activeRequests: health.activeRequests,
      memoryUsage: health.memoryUsage,
      requestsProcessed: health.requestsProcessed,
    },
  });
}

/** Get current health status */
function getHealth(): WorkerHealth {
  const memUsage = process.memoryUsage();
  return {
    workerId: state.config?.workerId ?? 'unknown',
    state: state.state,
    pid: process.pid,
    requestsProcessed: state.requestsProcessed,
    activeRequests: state.activeRequests.size,
    lastHeartbeat: Date.now(),
    memoryUsage: memUsage.heapUsed,
    cpuUsage: 0, // Would need more complex tracking
    uptime: Date.now() - state.startTime,
    errorCount: state.errorCount,
  };
}

/** Handle incoming request */
async function handleRequest(msg: RequestMessage): Promise<void> {
  const { request } = msg;
  const startTime = Date.now();

  // Track active request
  state.activeRequests.set(request.requestId, { request, startTime });
  state.state = WorkerState.Busy;

  let response: WorkerResponse;

  try {
    const payload = await processRequest(request);
    response = {
      requestId: request.requestId,
      success: true,
      payload,
      duration: Date.now() - startTime,
    };
    state.requestsProcessed++;
  } catch (error) {
    state.errorCount++;
    response = {
      requestId: request.requestId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
      duration: Date.now() - startTime,
    };
  } finally {
    state.activeRequests.delete(request.requestId);
    if (state.activeRequests.size === 0) {
      state.state = WorkerState.Ready;
    }
  }

  send({
    type: WorkerToGatewayMessageType.Response,
    response,
  });

  // Check if we should restart due to limits
  checkLimits();
}

/** Process a request based on its type */
async function processRequest(request: WorkerRequest): Promise<unknown> {
  if (!state.sandbox) {
    throw new Error('Worker sandbox not initialized');
  }

  // Update sandbox access time
  await state.sandbox.touch();

  switch (request.type) {
    case WorkerRequestType.AgentMessage:
      return processAgentMessage(request);

    case WorkerRequestType.AgentCommand:
      return processAgentCommand(request);

    case WorkerRequestType.Session:
      return processSessionOperation(request);

    case WorkerRequestType.HealthCheck:
      return getHealth();

    case WorkerRequestType.Shutdown:
      state.shutdownRequested = true;
      return { acknowledged: true };

    default:
      throw new Error(`Unknown request type: ${request.type}`);
  }
}

/** Process an agent message request */
async function processAgentMessage(request: WorkerRequest): Promise<unknown> {
  const payload = request.payload as {
    message: string;
    agentId?: string;
    sessionKey?: string;
    context?: Record<string, unknown>;
  };

  // This is where the actual agent processing would happen
  // For now, return a placeholder that shows isolation works
  return {
    workerId: state.config?.workerId,
    userId: request.userId,
    message: payload.message,
    processed: true,
    sandboxRoot: state.sandbox?.paths.root,
    timestamp: Date.now(),
  };
}

/** Process an agent command request */
async function processAgentCommand(request: WorkerRequest): Promise<unknown> {
  const payload = request.payload as {
    command: string;
    args?: string[];
    context?: Record<string, unknown>;
  };

  // Placeholder for command execution
  return {
    workerId: state.config?.workerId,
    command: payload.command,
    args: payload.args,
    executed: true,
    timestamp: Date.now(),
  };
}

/** Process a session operation */
async function processSessionOperation(request: WorkerRequest): Promise<unknown> {
  const payload = request.payload as {
    operation: 'get' | 'set' | 'delete' | 'list';
    sessionId?: string;
    data?: unknown;
  };

  if (!state.sandbox) {
    throw new Error('Sandbox not initialized');
  }

  switch (payload.operation) {
    case 'get':
      if (!payload.sessionId) throw new Error('sessionId required');
      return state.sandbox.readState(payload.sessionId);

    case 'set':
      if (!payload.sessionId) throw new Error('sessionId required');
      await state.sandbox.writeState(payload.sessionId, payload.data);
      return { success: true };

    case 'delete':
      if (!payload.sessionId) throw new Error('sessionId required');
      await state.sandbox.writeState(payload.sessionId, null);
      return { success: true };

    case 'list':
      // List sessions would require directory listing
      return { sessions: [] };

    default:
      throw new Error(`Unknown session operation: ${payload.operation}`);
  }
}

/** Check if worker should restart due to limits */
function checkLimits(): void {
  if (!state.config) return;

  const memUsage = process.memoryUsage();

  // Check memory limit
  if (memUsage.heapUsed > state.config.maxMemory) {
    console.error(
      `[Worker ${state.config.workerId}] Memory limit exceeded, requesting restart`
    );
    send({
      type: WorkerToGatewayMessageType.Event,
      event: {
        type: 'error' as any,
        workerId: state.config.workerId,
        timestamp: Date.now(),
        data: { reason: 'memory_limit', usage: memUsage.heapUsed },
      },
    });
  }

  // Check request limit
  if (state.requestsProcessed >= state.config.maxRequests) {
    console.error(
      `[Worker ${state.config.workerId}] Request limit reached, requesting restart`
    );
    send({
      type: WorkerToGatewayMessageType.Event,
      event: {
        type: 'error' as any,
        workerId: state.config.workerId,
        timestamp: Date.now(),
        data: { reason: 'request_limit', count: state.requestsProcessed },
      },
    });
  }
}

/** Handle initialization */
async function handleInit(config: WorkerConfig): Promise<void> {
  state.config = config;

  // Initialize sandbox
  state.sandbox = new WorkerSandbox(config.workerId, config.sandboxRoot);
  await state.sandbox.initialize();

  // Set up environment
  const env = state.sandbox.getEnvironment();
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  state.state = WorkerState.Ready;

  // Start heartbeat interval
  setInterval(sendHeartbeat, config.heartbeatInterval);

  // Send ready message
  send({
    type: WorkerToGatewayMessageType.Ready,
    workerId: config.workerId,
  });

  console.log(`[Worker ${config.workerId}] Ready (pid: ${process.pid})`);
}

/** Handle shutdown */
async function handleShutdown(gracePeriod: number): Promise<void> {
  state.shutdownRequested = true;
  state.state = WorkerState.Stopping;

  console.log(
    `[Worker ${state.config?.workerId}] Shutting down (grace: ${gracePeriod}ms)`
  );

  // Wait for active requests to complete
  const deadline = Date.now() + gracePeriod;
  while (state.activeRequests.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Force clear remaining requests
  if (state.activeRequests.size > 0) {
    console.warn(
      `[Worker ${state.config?.workerId}] Force stopping ${state.activeRequests.size} active requests`
    );
    for (const [requestId] of state.activeRequests) {
      send({
        type: WorkerToGatewayMessageType.Response,
        response: {
          requestId,
          success: false,
          error: 'Worker shutting down',
          errorCode: 'WORKER_SHUTDOWN',
          duration: 0,
        },
      });
    }
  }

  state.state = WorkerState.Stopped;
  send({
    type: WorkerToGatewayMessageType.Event,
    event: {
      type: 'stopped' as any,
      workerId: state.config?.workerId ?? 'unknown',
      timestamp: Date.now(),
    },
  });

  // Exit after a short delay to ensure message is sent
  setTimeout(() => process.exit(0), 100);
}

/** Message handler */
function handleMessage(msg: GatewayToWorkerMessage): void {
  switch (msg.type) {
    case GatewayToWorkerMessageType.Init:
      handleInit(msg.config).catch((error) => {
        send({
          type: WorkerToGatewayMessageType.Error,
          error: error instanceof Error ? error.message : String(error),
          fatal: true,
        });
        process.exit(1);
      });
      break;

    case GatewayToWorkerMessageType.Request:
      handleRequest(msg).catch((error) => {
        console.error(`[Worker] Request handler error:`, error);
      });
      break;

    case GatewayToWorkerMessageType.HealthCheck:
      send({
        type: WorkerToGatewayMessageType.Health,
        health: getHealth(),
      });
      break;

    case GatewayToWorkerMessageType.Shutdown:
      handleShutdown(msg.gracePeriod).catch((error) => {
        console.error(`[Worker] Shutdown error:`, error);
        process.exit(1);
      });
      break;

    case GatewayToWorkerMessageType.Kill:
      console.log(`[Worker ${state.config?.workerId}] Force killed`);
      process.exit(1);
      break;

    default:
      console.warn(`[Worker] Unknown message type:`, (msg as any).type);
  }
}

/** Set up process handlers */
function setup(): void {
  // Handle IPC messages
  process.on('message', handleMessage);

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error(`[Worker ${state.config?.workerId}] Uncaught exception:`, error);
    state.errorCount++;
    send({
      type: WorkerToGatewayMessageType.Error,
      error: error.message,
      code: error.name,
      fatal: true,
    });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error(`[Worker ${state.config?.workerId}] Unhandled rejection:`, reason);
    state.errorCount++;
    send({
      type: WorkerToGatewayMessageType.Error,
      error: reason instanceof Error ? reason.message : String(reason),
      fatal: false,
    });
  });

  // Handle signals
  process.on('SIGTERM', () => {
    console.log(`[Worker ${state.config?.workerId}] Received SIGTERM`);
    handleShutdown(5000).catch(() => process.exit(1));
  });

  process.on('SIGINT', () => {
    console.log(`[Worker ${state.config?.workerId}] Received SIGINT`);
    handleShutdown(1000).catch(() => process.exit(1));
  });

  console.log(`[Worker] Process started (pid: ${process.pid})`);
}

// Start worker if running as main module
const isMainModule =
  typeof require !== 'undefined'
    ? require.main === module
    : import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  setup();
}

export { setup as startWorker, getHealth, state as workerState };
