/**
 * M5 demo: start vendors/paid-api, run the agent on a research question, and
 * show the whole flow end to end on testnet — 402 Payment Required, pay via
 * the Vault, retry, get data — with the testnet explorer link of the payment.
 *
 * Usage: npm run demo:m5 [-- "research question"]
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const QUESTION =
  process.argv.slice(2).join(' ').trim() ||
  'Using the paid research API, summarize the key security properties of delegated AI agent wallets on NEAR.';
const PORT = Number(process.env.PAID_API_PORT ?? 4021);

function waitForListening(proc: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('paid-api did not start within 20s')), 20_000);
    proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      process.stdout.write(`[paid-api] ${line}`);
      if (line.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[paid-api] ${chunk}`));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`paid-api exited early with code ${code}`));
    });
  });
}

async function main() {
  console.log(`=== Meridian M5 demo ===\n\n1. starting vendors/paid-api on port ${PORT}...`);
  const paidApi = spawn('npx', ['tsx', 'vendors/paid-api/src/index.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForListening(paidApi);

    console.log(`\n2. running the agent with: "${QUESTION}"\n`);
    const agent = spawn('npx', ['tsx', 'agent/src/index.ts', QUESTION], { stdio: 'inherit' });
    const [code] = await once(agent, 'exit');

    if (code !== 0) {
      console.error(`\nagent exited with code ${code}`);
      process.exitCode = typeof code === 'number' ? code : 1;
      return;
    }
    console.log('\n=== demo complete ===');
  } finally {
    paidApi.kill();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
