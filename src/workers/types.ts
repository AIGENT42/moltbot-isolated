/**
 * Worker pool types for sticky routing with isolated sandboxes
 */

/** Unique identifier for a worker instance */
export type WorkerId = string;

/** Instance private keys for a worker */
export interface InstanceKeys {
  /** 32-byte private key for cryptographic operations */
  privateKey: Buffer;
  /** Unique instance identifier (workerId + timestamp + random) */
  instanceId: string;
  /** Fingerprint of the private key (first 8 bytes hex) for logging */
  fingerprint: string;
}

/** Unique identifier for a user (used for sticky routing) */
export type UserId = string;

/** Worker process state */
export enum WorkerState {
  /** Worker is starting up */
  Starting = 'starting',
  /** Worker is ready to accept requests */
  Ready = 'ready',
  /** Worker is processing a request */
  Busy = 'busy',
  /** Worker is shutting down */
  Stopping = 'stopping',
  /** Worker has stopped */
  Stopped = 'stopped',
  /** Worker has crashed */
  Crashed = 'crashed',
}

/** Worker health status */
export interface WorkerHealth {
  workerId: WorkerId;
  state: WorkerState;
  pid: number | null;
  /** Number of requests processed */
  requestsProcessed: number;
  /** Number of active requests */
  activeRequests: number;
  /** Last heartbeat timestamp */
  lastHeartbeat: number;
  /** Memory usage in bytes */
  memoryUsage: number;
  /** CPU usage percentage */
  cpuUsage: number;
  /** Uptime in milliseconds */
  uptime: number;
  /** Error count since start */
  errorCount: number;
}

/** Worker configuration */
export interface WorkerConfig {
  /** Worker ID */
  workerId: WorkerId;
  /** Sandbox root directory for this worker */
  sandboxRoot: string;
  /** Maximum concurrent requests per worker */
  maxConcurrent: number;
  /** Request timeout in milliseconds */
  requestTimeout: number;
  /** Heartbeat interval in milliseconds */
  heartbeatInterval: number;
  /** Maximum memory before restart (bytes) */
  maxMemory: number;
  /** Maximum requests before restart */
  maxRequests: number;
  /** Instance ID (unique per worker lifecycle) */
  instanceId?: string;
  /** Instance key fingerprint for logging/debugging */
  keyFingerprint?: string;
}

/** Worker pool configuration */
export interface WorkerPoolConfig {
  /** Number of workers to spawn */
  workerCount: number;
  /** Base directory for worker sandboxes */
  sandboxBaseDir: string;
  /** Worker-specific configuration */
  workerConfig: Omit<WorkerConfig, 'workerId' | 'sandboxRoot'>;
  /** Restart delay after crash (ms) */
  restartDelay: number;
  /** Maximum restart attempts before giving up */
  maxRestartAttempts: number;
  /** Time window for restart attempts (ms) */
  restartWindow: number;
}

/** Request to be processed by a worker */
export interface WorkerRequest {
  /** Unique request ID */
  requestId: string;
  /** User ID for sticky routing */
  userId: UserId;
  /** Request type */
  type: WorkerRequestType;
  /** Request payload */
  payload: unknown;
  /** Timestamp when request was created */
  timestamp: number;
  /** Request timeout override (ms) */
  timeout?: number;
}

/** Types of requests workers can handle */
export enum WorkerRequestType {
  /** Agent message processing */
  AgentMessage = 'agent:message',
  /** Agent command execution */
  AgentCommand = 'agent:command',
  /** Session operation */
  Session = 'session',
  /** Health check */
  HealthCheck = 'health:check',
  /** Graceful shutdown */
  Shutdown = 'shutdown',
}

/** Response from a worker */
export interface WorkerResponse {
  /** Request ID this responds to */
  requestId: string;
  /** Whether the request succeeded */
  success: boolean;
  /** Response payload */
  payload?: unknown;
  /** Error message if failed */
  error?: string;
  /** Error code if failed */
  errorCode?: string;
  /** Processing duration in milliseconds */
  duration: number;
}

/** Worker event types */
export enum WorkerEventType {
  /** Worker started and ready */
  Ready = 'ready',
  /** Worker heartbeat */
  Heartbeat = 'heartbeat',
  /** Worker error */
  Error = 'error',
  /** Worker crashed */
  Crash = 'crash',
  /** Worker stopped */
  Stopped = 'stopped',
  /** Request started */
  RequestStart = 'request:start',
  /** Request completed */
  RequestComplete = 'request:complete',
  /** Request failed */
  RequestFailed = 'request:failed',
}

/** Worker event payload */
export interface WorkerEvent {
  type: WorkerEventType;
  workerId: WorkerId;
  timestamp: number;
  data?: unknown;
}

/** Routing decision result */
export interface RoutingDecision {
  /** Target worker ID */
  workerId: WorkerId;
  /** User ID that was routed */
  userId: UserId;
  /** Hash value used for routing */
  hashValue: number;
  /** Whether this is a new assignment */
  isNewAssignment: boolean;
}

/** Worker pool status */
export interface WorkerPoolStatus {
  /** Total number of workers */
  totalWorkers: number;
  /** Number of healthy workers */
  healthyWorkers: number;
  /** Number of busy workers */
  busyWorkers: number;
  /** Total requests in queue */
  queuedRequests: number;
  /** Workers health status */
  workers: WorkerHealth[];
  /** Routing table size */
  routingTableSize: number;
}

/** Default worker pool configuration */
export const DEFAULT_WORKER_POOL_CONFIG: WorkerPoolConfig = {
  workerCount: 4,
  sandboxBaseDir: '/tmp/moltbot-workers',
  workerConfig: {
    maxConcurrent: 10,
    requestTimeout: 120_000, // 2 minutes
    heartbeatInterval: 5_000, // 5 seconds
    maxMemory: 512 * 1024 * 1024, // 512MB
    maxRequests: 10_000,
  },
  restartDelay: 1_000,
  maxRestartAttempts: 5,
  restartWindow: 60_000, // 1 minute
};
