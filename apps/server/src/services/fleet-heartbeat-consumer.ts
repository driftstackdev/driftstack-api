// Bounded consumer for authenticated fleet heartbeats.
//
// A heartbeat carries latest-state telemetry and may also trigger several DB
// reconciliation paths. FleetControlConnection receives frames synchronously;
// without coalescing, a compromised authenticated node can create unlimited
// overlapping DB work by sending valid heartbeats faster than those paths drain.

import type { Logger } from '../lib/logger.js';
import type { Heartbeat } from '../schemas/harness-control-protocol.js';
import { makeBoundedNodeLatestRelay } from './bounded-node-latest-relay.js';

interface FleetHeartbeatConsumerDeps {
  persistSnapshot(frame: Heartbeat): Promise<void>;
  recordLiveness(frame: Heartbeat): void | Promise<void>;
  reconcileWorkerOrphans(frame: Heartbeat): Promise<void>;
  reconcileNodeBoot(frame: Heartbeat): Promise<void>;
  logger: Logger;
}

type HeartbeatOperation =
  | 'persist_snapshot'
  | 'record_liveness'
  | 'reconcile_worker_orphans'
  | 'reconcile_node_boot';

async function runIsolated(
  operation: HeartbeatOperation,
  frame: Heartbeat,
  logger: Logger,
  task: () => void | Promise<void>,
): Promise<void> {
  try {
    await task();
  } catch (err) {
    logger.warn(
      {
        component: 'fleet-heartbeat-consumer',
        nodeId: frame.macNodeId,
        operation,
        err: err instanceof Error ? err.message : String(err),
      },
      'heartbeat subtask failed (newest pending heartbeat remains eligible)',
    );
  }
}

/**
 * Build the heartbeat callback wired into FleetControlRegistry. The registry
 * already requires frame.macNodeId to equal the connection's authenticated
 * node id. One beat per node is processed at a time; while it is in flight,
 * repeated beats collapse to one newest successor. Subtasks start together and
 * fail independently so a telemetry outage cannot suppress liveness/reconcile.
 */
export function makeFleetHeartbeatConsumer(
  deps: FleetHeartbeatConsumerDeps,
): (frame: Heartbeat) => void {
  const process = async (frame: Heartbeat): Promise<void> => {
    await Promise.all([
      runIsolated('persist_snapshot', frame, deps.logger, () => deps.persistSnapshot(frame)),
      runIsolated('record_liveness', frame, deps.logger, () => deps.recordLiveness(frame)),
      runIsolated('reconcile_worker_orphans', frame, deps.logger, () =>
        deps.reconcileWorkerOrphans(frame),
      ),
      runIsolated('reconcile_node_boot', frame, deps.logger, () => deps.reconcileNodeBoot(frame)),
    ]);
  };

  const bounded = makeBoundedNodeLatestRelay({
    getSessionId: (frame: Heartbeat) => frame.macNodeId,
    process: (frame) => process(frame),
    onError: ({ error, reportingNodeId }) => {
      deps.logger.error(
        { component: 'fleet-heartbeat-consumer', nodeId: reportingNodeId, err: error },
        'heartbeat consumer failed unexpectedly',
      );
    },
    // One authenticated node state contains only its own macNodeId key, so this
    // is unreachable unless that invariant changes. Keep a fail-closed guard.
    onOverflow: ({ reportingNodeId, sessionBudget }) => {
      deps.logger.warn(
        { component: 'fleet-heartbeat-consumer', nodeId: reportingNodeId, sessionBudget },
        'dropped heartbeat because the authenticated node exceeded its relay key budget',
      );
    },
  });

  return (frame: Heartbeat): void => {
    bounded(frame, frame.macNodeId);
  };
}
