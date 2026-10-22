// shadcn base-nova on Base UI, vendored from ~/code/purrable/packages/ui (ported from myapps' base-nova popover, MIT); edit
// here, there is no upstream sync. `container` portals the popup into an open <dialog> (a Sheet), whose top layer would
// otherwise cover it. `size="panel"` is a settings panel:
// as wide as a phone allows, as tall as the space beside its trigger, scrolling inside. `size="card"` is a link's card
// (CardLink): the same width with no inset, so a picture can run to its edges, opening a little slower from its trigger.
import * as React from 'react'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { cn } from '../../lib/cn.ts'

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/** 8px from each edge plus the app's safe area (`--safe-top` and friends), as the dropdown menu keeps. */
function edgePadding() {
  const style = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  const safe = (edge: string) => (style ? Number.parseFloat(style.getPropertyValue(`--safe-${edge}`)) || 0 : 0)
  return { top: 8 + safe('top'), right: 8 + safe('right'), bottom: 8 + safe('bottom'), left: 8 + safe('left') }
}

function PopoverContent({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  anchor,
  size = 'default',
  container,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset' | 'anchor'> &
  Pick<PopoverPrimitive.Portal.Props, 'container'> & {
    readonly size?: 'default' | 'panel' | 'card'
  }) {
  const padding = React.useMemo(edgePadding, [])
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={padding}
        anchor={anchor}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          data-size={size}
          className={cn(
            'z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-popover outline-hidden transition-[scale,opacity] duration-(--dur-base) ease-(--ease-out-strong) data-ending-style:duration-(--dur-fast) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 motion-reduce:transition-opacity motion-reduce:data-starting-style:scale-100 motion-reduce:data-ending-style:scale-100 data-[size=panel]:max-h-[min(32rem,var(--available-height))] data-[size=panel]:w-[min(22rem,calc(100vw-1rem))] data-[size=panel]:overflow-y-auto data-[size=panel]:overscroll-contain data-[size=panel]:rounded-xl data-[size=panel]:p-1.5 data-[size=card]:max-h-(--available-height) data-[size=card]:w-[min(22rem,calc(100vw-1rem))] data-[size=card]:gap-0 data-[size=card]:overflow-y-auto data-[size=card]:overscroll-contain data-[size=card]:rounded-xl data-[size=card]:p-0 data-[size=card]:duration-(--dur-base) data-[size=card]:ease-(--ease-out-strong) data-[size=card]:data-starting-style:scale-96 data-[size=card]:data-ending-style:scale-96 data-[size=card]:motion-reduce:data-starting-style:scale-100 data-[size=card]:motion-reduce:data-ending-style:scale-100',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return <PopoverPrimitive.Title data-slot="popover-title" className={cn('font-medium', className)} {...props} />
}

export { Popover, PopoverContent, PopoverTitle, PopoverTrigger }
