'use client';

import Link from 'next/link';

type Variant = 'primary' | 'secondary';

const BASE =
  'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50';

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover disabled:hover:bg-accent',
  secondary: 'border border-border bg-white text-ink hover:border-muted disabled:hover:border-border',
};

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      disabled={disabled || loading}
      className={[BASE, VARIANT_CLASS[variant], loading ? 'cursor-wait' : '', className ?? ''].join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = 'primary',
  className,
  children,
}: {
  href: string;
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={[BASE, VARIANT_CLASS[variant], className ?? ''].join(' ')}>
      {children}
    </Link>
  );
}
