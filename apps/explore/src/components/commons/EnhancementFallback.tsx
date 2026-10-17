import { Component, type ReactNode } from 'react'

/** Optional renderers must fail locally and leave the authored message available. */
export class EnhancementFallback extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
