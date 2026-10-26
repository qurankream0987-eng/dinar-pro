import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

// Compatibility adapter for existing Radix consumers; styles belong to ui/Button.
const buttonVariants = cva('dinar-button inline-flex items-center justify-center gap-2 text-center font-semibold', {
  variants: {
    variant: {
      default: 'dinar-button--primary',
      destructive: 'dinar-button--danger',
      outline: 'dinar-button--secondary',
      secondary: 'dinar-button--secondary',
      ghost: 'dinar-button--ghost',
      link: 'dinar-button--ghost underline underline-offset-4',
    },
    size: {
      default: 'dinar-button--md',
      sm: 'dinar-button--sm',
      lg: 'dinar-button--lg',
      icon: 'dinar-icon-button dinar-icon-button--md',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
