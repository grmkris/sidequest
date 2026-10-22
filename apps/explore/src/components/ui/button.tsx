/**
 * Button: shadcn base-nova on Base UI, vendored from purrable (packages/ui), set as stationery: the primary is evergreen
 * stock and the outline a cotton card, each with a lit edge and a cast falling right; a pointer lifts it 1px and a press
 * sets it 1px down. The focus ring is the page's outline, so it appears at once. Desktop controls are 36px; on a coarse
 * pointer every size grows to a 44px target.
 */
import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { Spinner } from './spinner.tsx'
import { cn } from '../../lib/cn.ts'

const buttonVariants = cva(
  "group/button inline-flex pointer-coarse:min-w-11 shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-normal text-center transition-[translate,background-color,color,border-color,opacity,box-shadow] duration-(--dur-fast) ease-(--ease-out-strong) select-none active:not-disabled:not-aria-[haspopup]:translate-y-px motion-reduce:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-stock [@media(hover:hover)]:hover:not-disabled:-translate-y-px [@media(hover:hover)]:hover:not-disabled:shadow-stock-lift',
        outline:
          'bg-card text-card-foreground shadow-stock aria-expanded:bg-muted aria-expanded:shadow-groove [@media(hover:hover)]:hover:not-disabled:-translate-y-px [@media(hover:hover)]:hover:not-disabled:shadow-stock-lift',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-accent aria-expanded:text-secondary-foreground',
        ghost: 'hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground',
        destructive:
          'bg-destructive/10 text-destructive-text hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20',
        link: 'h-auto min-h-0 px-0 py-0 pointer-coarse:min-h-11 text-primary underline underline-offset-4 decoration-current/35 hover:decoration-current',
      },
      size: {
        default:
          'h-auto min-h-9 gap-1.5 px-3 py-1 pointer-coarse:min-h-11 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5',
        xs: "h-auto min-h-6 gap-1 py-1 pointer-coarse:min-h-11 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-auto min-h-7 gap-1 py-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-ui pointer-coarse:min-h-11 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-auto min-h-11 gap-2 px-4 py-2 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        icon: 'size-9 pointer-coarse:size-11',
        'icon-xs':
          "size-6 pointer-coarse:size-11 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          'size-7 rounded-[min(var(--radius-md),12px)] pointer-coarse:size-11 in-data-[slot=button-group]:rounded-lg',
        'icon-lg': 'size-9 pointer-coarse:size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  busy,
  children,
  disabled,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { busy?: boolean | undefined }) {
  return (
    <ButtonPrimitive
      type="button"
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
      disabled={busy === true || disabled}
      aria-busy={busy === true ? true : undefined}
    >
      {busy === true && <Spinner data-icon="inline-start" role={undefined} aria-label={undefined} aria-hidden />}
      {children}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
