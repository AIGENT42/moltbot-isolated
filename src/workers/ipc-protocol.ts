/**
 * IPC protocol for gateway-worker communication
 *
 * Uses structured messages over Node.js IPC channel (process.send/on('message'))
 */

import type {
  WorkerConfig,
  WorkerEvent,
  WorkerHealth,
  WorkerId,
  WorkerRequest,
  WorkerResponse,
} from "./types.js";

/** IPC message types from gateway to worker */
export enum GatewayToWorkerMessageType {
  /** Initialize worker with config */
  Init = "init",
  /** Send request to worker */
  Request = "request",
  /** Request health status */
  HealthCheck = "health:check",
  /** Graceful shutdown */
  Shutdown = "shutdown",
  /** Force kill (last resort) */
  Kill = "kill",
}

/** IPC message types from worker to gateway */
export enum WorkerToGatewayMessageType {
  /** Worker is ready */
  Ready = "ready",
  /** Response to request */
  Response = "response",
  /** Health status report */
  Health = "health",
  /** Worker event notification */
  Event = "event",
  /** Worker error */
  Error = "error",
  /** Heartbeat */
  Heartbeat = "heartbeat",
}

/** Base IPC message structure */
export interface IPCMessageBase {
  /** Message type */
  type: string;
  /** Timestamp */
  ts: number;
}

// Gateway -> Worker messages

export interface InitMessage extends IPCMessageBase {
  type: GatewayToWorkerMessageType.Init;
  config: WorkerConfig;
}

export interface RequestMessage extends IPCMessageBase {
  type: GatewayToWorkerMessageType.Request;
  request: WorkerRequest;
}

export interface HealthCheckMessage extends IPCMessageBase {
  type: GatewayToWorkerMessageType.HealthCheck;
}

export interface ShutdownMessage extends IPCMessageBase {
  type: GatewayToWorkerMessageType.Shutdown;
  /** Grace period in milliseconds */
  gracePeriod: number;
}

export interface KillMessage extends IPCMessageBase {
  type: GatewayToWorkerMessageType.Kill;
}

export type GatewayToWorkerMessage =
  | InitMessage
  | RequestMessage
  | HealthCheckMessage
  | ShutdownMessage
  | KillMessage;

/** Helper type to distribute Omit over union members */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type GatewayToWorkerMessageInput = DistributiveOmit<GatewayToWorkerMessage, "ts">;

// Worker -> Gateway messages

export interface ReadyMessage extends IPCMessageBase {
  type: WorkerToGatewayMessageType.Ready;
  workerId: WorkerId;
}

export interface ResponseMessage extends IPCMessageBase {
  type: WorkerToGatewayMessageType.Response;
  response: WorkerResponse;
}

export interface HealthMessage extends IPCMessageBase {
  type: WorkerToGatewayMessageType.Health;
  health: WorkerHealth;
}

export interface EventMessage extends IPCMessageBase {
  type: WorkerToGatewayMessageType.Event;
  event: WorkerEvent;
}

export interface ErrorMessage extends IPCMessageBase {
  type: WorkerToGatewayMessageType.Error;
  error: string;
  code?: string;
  fatal?: boolean;
}

export interface HeartbeatMessage extends IPCMessageBase {
  type: WorkerToGatewayMessageType.Heartbeat;
  workerId: WorkerId;
  health: Partial<WorkerHealth>;
}

export type WorkerToGatewayMessage =
  | ReadyMessage
  | ResponseMessage
  | HealthMessage
  | EventMessage
  | ErrorMessage
  | HeartbeatMessage;

export type WorkerToGatewayMessageInput = DistributiveOmit<WorkerToGatewayMessage, "ts">;

/** Create a gateway->worker message */
export function createGatewayMessage(message: GatewayToWorkerMessageInput): GatewayToWorkerMessage {
  return {
    ...message,
    ts: Date.now(),
  } as GatewayToWorkerMessage;
}

/** Create a worker->gateway message */
export function createWorkerMessage(message: WorkerToGatewayMessageInput): WorkerToGatewayMessage {
  return {
    ...message,
    ts: Date.now(),
  } as WorkerToGatewayMessage;
}

/** Type guard for gateway messages */
export function isGatewayMessage(msg: unknown): msg is GatewayToWorkerMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.type === "string" &&
    Object.values(GatewayToWorkerMessageType).includes(m.type as GatewayToWorkerMessageType)
  );
}

/** Type guard for worker messages */
export function isWorkerMessage(msg: unknown): msg is WorkerToGatewayMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.type === "string" &&
    Object.values(WorkerToGatewayMessageType).includes(m.type as WorkerToGatewayMessageType)
  );
}

/** IPC channel interface for sending messages */
export interface IPCSender {
  send(message: GatewayToWorkerMessage | WorkerToGatewayMessage): boolean;
}

/** IPC channel interface for receiving messages */
export interface IPCReceiver {
  on(
    event: "message",
    listener: (message: GatewayToWorkerMessage | WorkerToGatewayMessage) => void,
  ): void;
  off(
    event: "message",
    listener: (message: GatewayToWorkerMessage | WorkerToGatewayMessage) => void,
  ): void;
}

/** Utility to wait for a specific message type */
export function waitForMessage<T extends WorkerToGatewayMessage>(
  receiver: IPCReceiver,
  type: T["type"],
  timeout: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      receiver.off("message", handler);
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeout);

    function handler(msg: GatewayToWorkerMessage | WorkerToGatewayMessage) {
      if (msg.type === type) {
        clearTimeout(timer);
        receiver.off("message", handler);
        resolve(msg as T);
      }
    }

    receiver.on("message", handler);
  });
}
