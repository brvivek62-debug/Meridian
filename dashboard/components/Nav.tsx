import Link from 'next/link';
import { NeutralPill } from '@/components/ui/Pill';

export function Nav() {
  return (
    <nav className="border-b border-border bg-white">
      <div className="mx-auto flex min-h-16 max-w-[1120px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-4 sm:gap-8">
          <Link href="/" className="text-[17px] font-semibold text-ink">
            Meridian
          </Link>
          <div className="flex items-center gap-4 sm:gap-6">
            <Link href="/" className="text-sm text-slate transition-colors hover:text-ink">
              Dashboard
            </Link>
            <Link href="/break" className="text-sm text-slate transition-colors hover:text-ink">
              Break it
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <NeutralPill>Testnet</NeutralPill>
          <a
            href="https://github.com/brvivek62-debug/Meridian"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-slate transition-colors hover:text-ink"
          >
            GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}
