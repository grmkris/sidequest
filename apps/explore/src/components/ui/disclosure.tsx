import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

/**
 * A summary that unfolds more in place. The panel takes its height at once and its content fades and settles 4px into
 * place (height is never animated); it folds the same way. With reduced motion it only fades.
 */
export function Disclosure({
  summary,
  children,
  className,
  defaultOpen = false,
}: {
  summary: ReactNode
  children: ReactNode
  className?: string
  defaultOpen?: boolean
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={className}>
      <Collapsible.Trigger className="group/disclosure inline-flex min-h-8 cursor-pointer items-center gap-1 rounded-md px-1 text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11">
        <ChevronRight
          aria-hidden
          className="size-4 text-muted-foreground transition-transform duration-(--dur-fast) ease-(--ease-out-strong) group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
        />
        {summary}
      </Collapsible.Trigger>
      <Collapsible.Panel
        className={cn(
          'transition-[opacity,translate] duration-(--dur-base) ease-(--ease-out-strong)',
          'data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0',
          'motion-reduce:transition-[opacity]',
        )}
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}
