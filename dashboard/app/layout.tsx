import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Meridian — the line your agents can’t cross',
  description: 'Live view of delegated, policy-checked spending for AI agents on NEAR.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-navy text-offwhite font-sans antialiased">{children}</body>
    </html>
  );
}
