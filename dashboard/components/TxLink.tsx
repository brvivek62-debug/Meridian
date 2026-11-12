import { Pill } from '@/components/ui/Pill';

export function TxLink({ explorer }: { explorer: string }) {
  return (
    <a href={explorer} target="_blank" rel="noreferrer" className="inline-block text-[13px] font-medium text-accent hover:underline">
      View tx ↗
    </a>
  );
}

export function RuleTag({ rule }: { rule: string }) {
  return <Pill tone="danger">{rule}</Pill>;
}
