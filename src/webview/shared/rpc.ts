import { post, log } from '../vscode-api.js';
import type {
  HostToView,
  ModelMutationRequest
} from '../../editors/protocol.js';

let pendingRequestId = 0;
const pendingRequests = new Map<
  string,
  (ok: boolean, data?: unknown, error?: string) => void
>();

function nextId(): string {
  return `r${++pendingRequestId}`;
}

/**
 * Sends a `view.mutateModel` request to the host and resolves when the
 * matching `host.ack` arrives. Returns the ack's `data` payload on success,
 * `undefined` on failure (and logs the host's error message).
 */
export function requestMutation<T>(
  mutation: ModelMutationRequest
): Promise<T | undefined> {
  return new Promise(resolve => {
    const requestId = nextId();
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
 * Show a VS Code QuickPick.
 *
 * Items can carry any additional fields beyond {label, description}; only
 * label and description are displayed. The original picked object is
 * returned, so callers can attach element ids or other state directly on
 * the item rather than smuggling them through the visible `detail` field.
 */
export function showQuickPick<
  T extends { label: string; description?: string }
>(
  items: T[],
  options?: { placeHolder?: string; title?: string }
): Promise<T | undefined> {
  return new Promise(resolve => {
    const requestId = nextId();
    pendingRequests.set(requestId, (_ok, data) => {
      const ack = data as { index?: number } | undefined;
      if (!ack || typeof ack.index !== 'number') {
        resolve(undefined);
      } else {
        resolve(items[ack.index]);
      }
    });
    post({
      type: 'view.quickPick',
      requestId,
      items: items.map(i => ({ label: i.label, description: i.description })),
      placeHolder: options?.placeHolder,
      title: options?.title
    });
  });
}

/** Show a VS Code InputBox. Resolves to the string entered, or undefined on cancel. */
export function showInputBox(options?: {
  prompt?: string;
  value?: string;
  placeHolder?: string;
  title?: string;
}): Promise<string | undefined> {
  return new Promise(resolve => {
    const requestId = nextId();
    pendingRequests.set(requestId, (_ok, data) => {
      const v = data as { value?: string } | undefined;
      resolve(v?.value);
    });
    post({
      type: 'view.inputBox',
      requestId,
      prompt: options?.prompt,
      value: options?.value,
      placeHolder: options?.placeHolder,
      title: options?.title
    });
  });
}

/** Modal OK/Cancel confirmation. Resolves to true if confirmed. */
export function confirm(message: string, okLabel?: string): Promise<boolean> {
  return new Promise(resolve => {
    const requestId = nextId();
    pendingRequests.set(requestId, (_ok, data) => {
      const v = data as { confirmed?: boolean } | undefined;
      resolve(v?.confirmed === true);
    });
    post({ type: 'view.confirm', requestId, message, okLabel });
  });
}

/** Fire-and-forget notification toast. */
export function showMessage(
  level: 'info' | 'warn' | 'error',
  message: string
): void {
  post({ type: 'view.showMessage', level, message });
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
