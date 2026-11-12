import { NeutralPill, Pill } from '@/components/ui/Pill';

export function DemoModeBadge() {
  return <NeutralPill>Demo mode — testnet</NeutralPill>;
}

export function RoleBadge({ role }: { role: 'production' | 'demo' }) {
  if (role === 'production') return <Pill tone="neutral">Production</Pill>;
  return <Pill tone="accent">Demo sandbox</Pill>;
}

export function StatusChip({ status }: { status: string }) {
  const tone = status === 'Blocked' ? 'danger' : status === 'Pending' ? 'pending' : status === 'Rejected' ? 'danger' : 'success';
  return <Pill tone={status === 'Open' ? 'neutral' : tone}>{status}</Pill>;
}
