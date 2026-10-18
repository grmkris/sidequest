// shadcn base-nova style, vendored from ~/code/purrable/packages/ui; edit here, there is no upstream sync. A quantity within
// known bounds (a success rate, a weekly budget used, progress to the next fee tier) on Base UI's Meter: a thin track whose
// fill glides when the value changes. Not a Progress: nothing here is "loading". `fill` colours the indicator.
import { Meter as MeterPrimitive } from '@base-ui/react/meter'
import { cn } from '../../lib/cn.ts'

function Meter({ className, children, fill, ...props }: MeterPrimitive.Root.Props & { fill?: string }) {
  const min = props.min ?? 0
  const max = props.max ?? 100
  const share = max > min ? Math.min(1, Math.max(0, (props.value - min) / (max - min))) : 0
  return (
    <MeterPrimitive.Root data-slot="meter" className={cn('flex w-full min-w-0 flex-col gap-2', className)} {...props}>
      {children}
      <MeterPrimitive.Track data-slot="meter-track" className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {/* The fill is always full width and slides in from the left, clipped by the track: a transform, not a width. */}
        <MeterPrimitive.Indicator
          data-slot="meter-indicator"
          style={{ translate: `${(share - 1) * 100}% 0` }}
          className={cn(
            'h-full w-full! rounded-full bg-primary transition-[translate] duration-(--dur-slow) ease-(--ease-out-strong) motion-reduce:transition-none',
            fill,
          )}
        />
      </MeterPrimitive.Track>
    </MeterPrimitive.Root>
  )
}

export { Meter }
