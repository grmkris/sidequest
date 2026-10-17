import { Component, lazy, Suspense, useState, type ReactNode } from 'react'
import { Button } from '../ui/button.tsx'

const HighlightedCode = lazy(() => import('./HighlightedCode.tsx'))
const Diagram = lazy(() => import('./Diagram.tsx'))

/** Optional enhancements load only after a reader asks; source always remains available. */
export function CodeFence({ code, language }: { code: string; language: string }) {
  const [enhanced, setEnhanced] = useState(false)
  const [copy, setCopy] = useState('Copy code')
  const isDiagram = language === 'mermaid'
  const source = (
    <pre>
      <code>{code}</code>
    </pre>
  )
  return (
    <div className="commons-code">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1 text-ui">
        <span className="text-muted-foreground">{language || 'Plain text'}</span>
        <div className="flex flex-wrap gap-1">
          {language !== '' && (
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              aria-pressed={enhanced}
              onClick={() => setEnhanced(!enhanced)}
            >
              {enhanced ? 'Show source' : isDiagram ? 'Show diagram' : 'Highlight code'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            onClick={() => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(code)
                  setCopy('Copied')
                } catch {
                  setCopy('Select code to copy')
                }
              })()
            }}
          >
            {copy}
          </Button>
        </div>
      </div>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Named overflow needs keyboard access in Safari. */}
      <section aria-label="Code block" tabIndex={0} className="max-h-96 overflow-auto">
        {enhanced ? (
          <EnhancementFallback fallback={source}>
            <Suspense fallback={source}>
              {isDiagram ? <Diagram code={code} /> : <HighlightedCode code={code} language={language} />}
            </Suspense>
          </EnhancementFallback>
        ) : (
          source
        )}
      </section>
    </div>
  )
}

/** A failed optional chunk or renderer must leave the authored code readable. */
class EnhancementFallback extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
