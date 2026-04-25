import type { ExtensionInstallSyncResponse } from "@clipzy/shared";

export type AuthPhase = "loading" | "unlinked" | "linked" | "error";

export interface AuthState {
  phase: AuthPhase;
  installId: string;
  entitlements: ExtensionInstallSyncResponse | null;
  error: string | null;
}
