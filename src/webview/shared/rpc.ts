import { post, log } from '../vscode-api.js';
import type { ModelMutationRequest } from '../../editors/protocol.js';
import type { HostToView } from '../../editors/protocol.js';

let pendingRequestId = 0;
const pendingRequests = new Map<
  string,
  (ok: boolean, data?: unknown, error?: string) => void
>();

/**
 * Sends a `view.mutateModel` request to the host and resolves when the
 * matching `host.ack` arrives. Returns the ack's `data` payload on success,
 * `undefined` on failure (and logs the host's error message).
 */
export function requestMutation<T>(
  mutation: ModelMutationRequest
): Promise<T | undefined> {
  return new Promise(resolve => {
    const requestId = `r${++pendingRequestId}`;
    pendingRequests.set(requestId, (ok, data, error) => {
      if (!ok) {
        log('error', `mutation failed: ${error}`);
        resolve(undefined);
      } else {
        resolve(data as T);
      }
    });
    post({ type: 'view.mutateModel', requestId, mutation });
  });
}

/**
 * Route a `host.ack` to its waiting requester. Call from the host-message
 * dispatcher in the entry point.
 */
export function resolveAck(
  msg: Extract<HostToView, { type: 'host.ack' }>
): void {
  const cb = pendingRequests.get(msg.requestId);
  pendingRequests.delete(msg.requestId);
  cb?.(msg.ok, msg.data, msg.error);
}
