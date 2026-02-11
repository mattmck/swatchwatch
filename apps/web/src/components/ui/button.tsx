import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "relative isolate inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold tracking-tight transition-all duration-200 ease-out disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive shadow-[0_10px_25px_rgba(66,16,126,0.12)] enabled:hover:scale-[1.02] enabled:hover:-translate-y-[1px] enabled:hover:shadow-[0_18px_38px_rgba(66,16,126,0.2)] enabled:active:translate-y-[1px] enabled:active:scale-[0.99] enabled:active:shadow-[0_10px_22px_rgba(66,16,126,0.18)] after:pointer-events-none after:absolute after:inset-0 after:bg-[color:oklch(0.852_0.107_341.3/.35)] after:opacity-0 after:transition-opacity after:duration-150 enabled:hover:after:opacity-100 enabled:active:after:opacity-60 data-[variant=ghost]:shadow-none data-[variant=ghost]:after:hidden data-[variant=ghost]:enabled:hover:scale-100 data-[variant=ghost]:enabled:hover:shadow-none data-[variant=ghost]:enabled:active:scale-100 data-[variant=ghost]:enabled:active:shadow-none data-[variant=link]:shadow-none data-[variant=link]:after:hidden data-[variant=link]:enabled:hover:scale-100 data-[variant=link]:enabled:hover:shadow-none data-[variant=link]:enabled:active:scale-100 data-[variant=link]:enabled:active:shadow-none",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60 shadow-[0_12px_30px_rgba(240,68,56,0.35)]",
        outline:
          "border border-border/80 bg-background/90 hover:bg-brand-pink-light/20 hover:text-brand-purple-deep dark:bg-input/30 dark:border-input dark:hover:bg-brand-purple/20 dark:hover:text-brand-lilac",
        brand:
          "bg-gradient-brand text-white shadow-glow-brand hover:opacity-95",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = (asChild ? Slot.Root : "button") as any

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
