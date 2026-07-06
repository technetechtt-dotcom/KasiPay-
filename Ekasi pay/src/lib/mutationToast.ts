import { toast } from 'sonner';
import { ApiError } from '../services/api';
import { pushClientDiag } from '../services/clientDiagnostics';

export function toastMutationError(actionLabel: string, err: unknown): void {
  const msg =
    err instanceof ApiError ?
      err.message
    : `Something went wrong: ${actionLabel}. Check your connection and try again.`;
  pushClientDiag(`${actionLabel}: ${err instanceof ApiError ? `${err.message} (${err.status})` : String(err)}`);
  toast.error(msg);
}

export function toastMutationSuccess(shortMessage: string): void {
  toast.success(shortMessage);
}
