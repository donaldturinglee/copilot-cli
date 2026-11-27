import React, { Component } from 'react'
import { ErrorOverview } from '../ink/components/error_overview.js'
import { logForDebugging } from '../utilities/debug.js'

export type SentryErrorBoundaryProps = {
  children: React.ReactNode
  fallback?: (error: Error) => React.ReactNode
  onError?: (error: Error) => void
}

type State = {
  error: Error | null
}

export class SentryErrorBoundary extends Component<
  SentryErrorBoundaryProps,
  State
> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    logForDebugging(`[ErrorBoundary] Caught UI error: ${error.message}`)
    this.props.onError?.(error)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error)
      }
      return <ErrorOverview error={this.state.error} />
    }
    return this.props.children
  }
}
