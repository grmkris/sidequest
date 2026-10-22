// shadcn base-nova on Base UI, vendored from ~/code/purrable/packages/ui; edit here, there is no upstream sync.
import * as React from 'react'
import { Input as InputPrimitive } from '@base-ui/react/input'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn.ts'

const inputVariants = cva('', {
  variants: {
    variant: {
      default: '',
      /** A short code people copy from an email: monospaced, spaced and large enough to read back. */
      code: 'font-mono text-lg tracking-widest tabular-nums md:text-lg',
    },
  },
  defaultVariants: { variant: 'default' },
})

function Input({
  className,
  type,
  variant,
  ...props
}: React.ComponentProps<'input'> & VariantProps<typeof inputVariants>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-card px-2.5 py-1 text-base transition-colors file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-55 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 pointer-coarse:h-11 md:text-sm',
        cn(inputVariants({ variant }), className),
      )}
      {...props}
    />
  )
}

export { Input }
