// Real WebKit driver — NOT YET INTEGRATED.
//
// This stub is what the driver factory returns when DRIVER=webkit is set.
// Every method throws DriverNotIntegratedError. The class exists so that the
// route layer can construct + use a Driver implementation; when the
// Driftstack WebKit fork closes its Phase 2, this file is replaced with the
// real adapter (and the WebKit fork hands off the binding details).

import { DriverNotIntegratedError } from '../lib/errors.js';
import type {
  CaptureInput,
  CaptureResult,
  ExtractInput,
  ExtractResult,
  SearchInput,
  SearchResult,
  LoginInput,
  LoginResult,
  CreateSessionInput,
  CreateSessionResult,
  Driver,
  DriverSessionId,
  GUIInputInput,
  GUIInputResult,
  InteractInput,
  InteractResult,
  NavigateInput,
  NavigateResult,
  SessionStateResult,
  WaitInput,
  WaitResult,
} from './types.js';

export class WebKitDriver implements Driver {
  readonly searchCapability = 'unavailable' as const;
  readonly loginCapability = 'unavailable' as const;
  async createSession(_input: CreateSessionInput): Promise<CreateSessionResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
  async navigate(_sessionId: DriverSessionId, _input: NavigateInput): Promise<NavigateResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
  async interact(_sessionId: DriverSessionId, _input: InteractInput): Promise<InteractResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
  async guiInput(_sessionId: DriverSessionId, _input: GUIInputInput): Promise<GUIInputResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
  async wait(_sessionId: DriverSessionId, _input: WaitInput): Promise<WaitResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
  async getState(_sessionId: DriverSessionId): Promise<SessionStateResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
  async capture(_sessionId: DriverSessionId, _input: CaptureInput): Promise<CaptureResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
  async extract(_sessionId: DriverSessionId, _input: ExtractInput): Promise<ExtractResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
  async search(_sessionId: DriverSessionId, _input: SearchInput): Promise<SearchResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
  async login(_sessionId: DriverSessionId, _input: LoginInput): Promise<LoginResult> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
  async destroy(_sessionId: DriverSessionId): Promise<void> {
    await Promise.resolve();
    throw new DriverNotIntegratedError();
  }
}
