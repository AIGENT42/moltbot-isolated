/**
 * Worker Pool Module - Sticky routing with isolated workers
 *
 * Provides:
 * - Sticky routing: userId → workerId (consistent hashing)
 * - Isolated sandboxes: Each worker has isolated filesystem/state
 * - Worker pool management: Spawn, monitor, restart workers
 * - Gateway integration: Routes requests through worker pool
 *
 * Architecture:
 * ```
 * ┌─────────────────────────────────────────────────────────┐
 * │                      Gateway                            │
 * │                   (Fixed Port)                          │
 * └─────────────────────┬───────────────────────────────────┘
 *                       │
 *                       ▼
 * ┌─────────────────────────────────────────────────────────┐
 * │                  Gateway Router                         │
 * │            (Sticky Routing Layer)                       │
 * │         userId → workerId (consistent hash)             │
 * └─────────────────────┬───────────────────────────────────┘
 *                       │
 *          ┌────────────┼────────────┐
 *          │            │            │
 *          ▼            ▼            ▼
 * ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 * │   Worker 0   │ │   Worker 1   │ │   Worker N   │
 * │  (Isolated)  │ │  (Isolated)  │ │  (Isolated)  │
 * ├──────────────┤ ├──────────────┤ ├──────────────┤
 * │   Sandbox    │ │   Sandbox    │ │   Sandbox    │
 * │  /sessions/  │ │  /sessions/  │ │  /sessions/  │
 * │  /state/     │ │  /state/     │ │  /state/     │
 * │  /cache/     │ │  /cache/     │ │  /cache/     │
 * └──────────────┘ └──────────────┘ └──────────────┘
 * ```
 *
 * Usage:
 * ```ts
 * import { createGatewayRouter } from './workers';
 *
 * const router = createGatewayRouter({
 *   poolConfig: {
 *     workerCount: 4,
 *     sandboxBaseDir: '/var/moltbot/workers',
 *   },
 * });
 *
 * await router.start();
 *
 * // Route a request
 * const response = await router.route({
 *   type: 'agent',
 *   userId: 'user123',
 *   payload: { message: 'Hello' },
 * });
 *
 * // Get worker for a user
 * const workerId = router.getWorkerForUser('user123');
 *
 * // Get pool status
 * const status = router.getStatus();
 *
 * await router.stop();
 * ```
 */

// Types
export {
  type UserId,
  type WorkerId,
  type WorkerConfig,
  type WorkerHealth,
  type WorkerPoolConfig,
  type WorkerPoolStatus,
  type WorkerRequest,
  type WorkerResponse,
  type RoutingDecision,
  WorkerState,
  WorkerRequestType,
  WorkerEventType,
  DEFAULT_WORKER_POOL_CONFIG,
} from './types.js';

// IPC Protocol
export {
  type GatewayToWorkerMessage,
  type WorkerToGatewayMessage,
  GatewayToWorkerMessageType,
  WorkerToGatewayMessageType,
  createGatewayMessage,
  createWorkerMessage,
  isGatewayMessage,
  isWorkerMessage,
} from './ipc-protocol.js';

// Sticky Router
export {
  StickyRouter,
  type StickyRouterState,
  createStickyRouter,
} from './sticky-router.js';

// Worker Sandbox
export {
  WorkerSandbox,
  SandboxManager,
  type SandboxPaths,
  type SandboxMetadata,
  type SandboxDiskUsage,
} from './worker-sandbox.js';

// Worker Pool
export { WorkerPool, type WorkerPoolEvents } from './worker-pool.js';

// Gateway Router
export {
  GatewayRouter,
  type GatewayRouterOptions,
  type GatewayRequest,
  type GatewayResponse,
  createGatewayRouter,
  routeRequest,
} from './gateway-router.js';
