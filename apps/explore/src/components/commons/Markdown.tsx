import { lazy, Suspense } from 'react'
import { EnhancementFallback } from './EnhancementFallback.tsx'

const Content = lazy(() => import('./MarkdownContent.tsx'))

/** Authored text paints immediately, even if the optional formatter cannot load. */
export function Markdown({ children }: { children: string }) {
  const plain = <div className="commons-markdown whitespace-pre-line">{children}</div>
  return (
    <EnhancementFallback fallback={plain}>
      <Suspense fallback={plain}>
        <Content>{children}</Content>
      </Suspense>
    </EnhancementFallback>
  )
}
