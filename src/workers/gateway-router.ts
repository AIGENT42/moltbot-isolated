/**
 * Gateway Router Integration - Connects gateway to worker pool
 *
 * This module provides the bridge between the gateway's request handling
 * and the worker pool with sticky routing.
 */

import { randomUUID } from 'node:crypto';
import { WorkerPool } from './worker-pool.js';
import {
  type UserId,
  type WorkerId,
  type WorkerPoolConfig,
  type WorkerPoolStatus,
  type WorkerRequest,
  type WorkerResponse,
  WorkerRequestType,
} from './types.js';

/** Options for gateway router */
export interface GatewayRouterOptions {
  /** Worker pool configuration */
  poolConfig?: Partial<WorkerPoolConfig>;
  /** Whether to enable worker pool (false = direct processing) */
  enabled?: boolean;
  /** Custom user ID extractor */
  extractUserId?: (request: GatewayRequest) => UserId;
}

/** Gateway request - incoming request to be routed */
export interface GatewayRequest {
  /** Request type */
  type: 'agent' | 'command' | 'session';
  /** User/peer identifier */
  userId?: string;
  /** Session key (can be used as fallback for userId) */
  sessionKey?: string;
  /** Channel identifier */
  channel?: string;
  /** Agent ID */
  agentId?: string;
  /** Request payload */
  payload: unknown;
  /** Request metadata */
  metadata?: Record<string, unknown>;
}

/** Gateway response - response from worker */
export interface GatewayResponse {
  /** Whether the request succeeded */
  success: boolean;
  /** Response payload */
  payload?: unknown;
  /** Error message if failed */
  error?: string;
  /** Worker that processed the request */
  workerId?: WorkerId;
  /** Processing duration in milliseconds */
  duration?: number;
}

/**
 * Default user ID extractor
 * Uses userId, sessionKey, or generates a random ID
 */
function defaultExtractUserId(request: GatewayRequest): UserId {
  if (request.userId) {
    return request.userId;
  }
  if (request.sessionKey) {
    return request.sessionKey;
  }
  // Fallback: generate a random user ID (not sticky, but safe)
  return `anon:${randomUUID()}`;
}

/**
 * Gateway Router - routes requests through worker pool
 */
export class GatewayRouter {
  private pool: WorkerPool | null = null;
  private options: Required<GatewayRouterOptions>;
  private started = false;

  constructor(options: GatewayRouterOptions = {}) {
    this.options = {
      poolConfig: options.poolConfig ?? {},
      enabled: options.enabled ?? true,
      extractUserId: options.extractUserId ?? defaultExtractUserId,
    };
  }

  /**
   * Start the gateway router
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.options.enabled) {
      this.pool = new WorkerPool(this.options.poolConfig);

      // Set up event handlers
      this.pool.on('worker:ready', (workerId) => {
        console.log(`[GatewayRouter] Worker ${workerId} ready`);
      });

      this.pool.on('worker:crash', (workerId, error) => {
        console.error(`[GatewayRouter] Worker ${workerId} crashed:`, error.message);
      });

      this.pool.on('pool:ready', () => {
        console.log(`[GatewayRouter] Worker pool ready`);
      });

      this.pool.on('pool:degraded', (healthy, total) => {
        console.warn(`[GatewayRouter] Pool degraded: ${healthy}/${total} healthy`);
      });

      await this.pool.start();
    }

    this.started = true;
    console.log(
      `[GatewayRouter] Started (workers: ${this.options.enabled ? 'enabled' : 'disabled'})`
    );
  }

  /**
   * Stop the gateway router
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.pool) {
      await this.pool.stop();
      this.pool = null;
    }

    this.started = false;
    console.log(`[GatewayRouter] Stopped`);
  }

  /**
   * Route and process a request
   */
  async route(request: GatewayRequest): Promise<GatewayResponse> {
    if (!this.started) {
      throw new Error('Gateway router not started');
    }

    // If workers are disabled, process directly
    if (!this.pool) {
      return this.processDirectly(request);
    }

    // Extract user ID for routing
    const userId = this.options.extractUserId(request);

    // Create worker request
    const workerRequest: WorkerRequest = {
      requestId: randomUUID(),
      userId,
      type: this.mapRequestType(request.type),
      payload: request.payload,
      timestamp: Date.now(),
    };

    try {
      const response = await this.pool.sendRequest(workerRequest);
      return {
        success: response.success,
        payload: response.payload,
        error: response.error,
        workerId: this.pool.getWorkerForUser(userId) ?? undefined,
        duration: response.duration,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the worker ID for a user (for debugging/monitoring)
   */
  getWorkerForUser(userId: UserId): WorkerId | null {
    return this.pool?.getWorkerForUser(userId) ?? null;
  }

  /**
   * Get pool status
   */
  getStatus(): WorkerPoolStatus | null {
    return this.pool?.getStatus() ?? null;
  }

  /**
   * Check if workers are enabled
   */
  isEnabled(): boolean {
    return this.options.enabled && this.pool !== null;
  }

  /**
   * Map gateway request type to worker request type
   */
  private mapRequestType(type: GatewayRequest['type']): WorkerRequestType {
    switch (type) {
      case 'agent':
        return WorkerRequestType.AgentMessage;
      case 'command':
        return WorkerRequestType.AgentCommand;
      case 'session':
        return WorkerRequestType.Session;
      default:
        return WorkerRequestType.AgentMessage;
    }
  }

  /**
   * Process request directly (when workers are disabled)
   */
  private async processDirectly(request: GatewayRequest): Promise<GatewayResponse> {
    const startTime = Date.now();

    try {
      // This is a placeholder for direct processing
      // In a real implementation, this would call the agent/command handlers directly
      return {
        success: true,
        payload: {
          processed: true,
          direct: true,
          type: request.type,
        },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }
}

/**
 * Create a gateway router with default configuration
 */
export function createGatewayRouter(
  options?: GatewayRouterOptions
): GatewayRouter {
  return new GatewayRouter(options);
}

/**
 * Middleware-style function for integrating with existing gateway
 *
 * Usage:
 * ```ts
 * const router = createGatewayRouter({ enabled: true });
 * await router.start();
 *
 * // In request handler:
 * const response = await router.route({
 *   type: 'agent',
 *   userId: message.from.id,
 *   sessionKey: resolvedRoute.sessionKey,
 *   payload: { message: message.text },
 * });
 * ```
 */
export async function routeRequest(
  router: GatewayRouter,
  request: GatewayRequest
): Promise<GatewayResponse> {
  return router.route(request);
}
