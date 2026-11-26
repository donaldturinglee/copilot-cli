/**
 * Singleton state manager for streaming AWS / GCP CLI authentication refresh
 * command output to UI observers.
 */

import { createSignal } from './signal.js'

export interface AwsAuthStatus {
  isAuthenticating: boolean
  output: string[]
  error?: string
}

/**
 * Manages live status and stdout/stderr lines emitted by `awsAuthRefresh` and
 * `gcpAuthRefresh` subprocesses.
 */
export class AwsAuthStatusManager {
  private static instance: AwsAuthStatusManager | null = null

  private status: AwsAuthStatus = {
    isAuthenticating: false,
    output: [],
  }
  private readonly changed = createSignal<[status: AwsAuthStatus]>()

  static getInstance(): AwsAuthStatusManager {
    if (!AwsAuthStatusManager.instance) {
      AwsAuthStatusManager.instance = new AwsAuthStatusManager()
    }
    return AwsAuthStatusManager.instance
  }

  static reset(): void {
    AwsAuthStatusManager.instance = null
  }

  getStatus(): AwsAuthStatus {
    return {
      ...this.status,
      output: [...this.status.output],
    }
  }

  startAuthentication(): void {
    this.status = {
      isAuthenticating: true,
      output: [],
      error: undefined,
    }
    this.emit()
  }

  addOutput(line: string): void {
    this.status = {
      ...this.status,
      output: [...this.status.output, line],
    }
    this.emit()
  }

  setError(error: string): void {
    this.status = {
      ...this.status,
      error,
    }
    this.emit()
  }

  endAuthentication(success: boolean): void {
    if (success) {
      this.status = {
        isAuthenticating: false,
        output: [],
        error: undefined,
      }
    } else {
      this.status = {
        ...this.status,
        isAuthenticating: false,
      }
    }
    this.emit()
  }

  subscribe(listener: (status: AwsAuthStatus) => void): () => void {
    return this.changed.subscribe(listener)
  }

  private emit(): void {
    this.changed.emit(this.getStatus())
  }
}
