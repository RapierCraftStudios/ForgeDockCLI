// SPDX-License-Identifier: AGPL-3.0-or-later

export type GracefulTerminationSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

const SIGNAL_EXIT_CODES: Readonly<Record<GracefulTerminationSignal, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export class ProcessSignalAbortError extends Error {
  readonly exitCode: number;

  constructor(readonly signal: GracefulTerminationSignal) {
    const exitCode = SIGNAL_EXIT_CODES[signal];
    super(`ForgeDock interrupted by ${signal}`);
    this.name = "ProcessSignalAbortError";
    this.exitCode = exitCode;
  }
}

export interface ProcessSignalHooks {
  on(signal: GracefulTerminationSignal, listener: () => void): void;
  off(signal: GracefulTerminationSignal, listener: () => void): void;
  setExitCode(code: number): void;
  forceExit(code: number): void;
}

export interface GracefulSignalLifecycle {
  signal: AbortSignal;
  readonly interruption: ProcessSignalAbortError | undefined;
  dispose(): void;
}

const signals = Object.keys(SIGNAL_EXIT_CODES) as GracefulTerminationSignal[];

export function installGracefulSignalHandlers(
  hooks: ProcessSignalHooks = nodeProcessSignalHooks(),
): GracefulSignalLifecycle {
  const controller = new AbortController();
  let interruption: ProcessSignalAbortError | undefined;
  let disposed = false;
  const listeners = new Map<GracefulTerminationSignal, () => void>();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) hooks.off(signal, listener);
    listeners.clear();
  };

  for (const signal of signals) {
    const listener = (): void => {
      if (interruption) {
        const exitCode = interruption.exitCode;
        dispose();
        hooks.forceExit(exitCode);
        return;
      }
      interruption = new ProcessSignalAbortError(signal);
      hooks.setExitCode(interruption.exitCode);
      controller.abort(interruption);
    };
    listeners.set(signal, listener);
    hooks.on(signal, listener);
  }

  return {
    signal: controller.signal,
    get interruption() { return interruption; },
    dispose,
  };
}

function nodeProcessSignalHooks(): ProcessSignalHooks {
  return {
    on: (signal, listener) => { process.on(signal, listener); },
    off: (signal, listener) => { process.off(signal, listener); },
    setExitCode: (code) => { process.exitCode = code; },
    forceExit: (code) => { process.exit(code); },
  };
}
