/**
 * M6 demo: start vendors/paid-api, worker-scraper and worker-summarizer, then
 * run the agent in marketplace mode (--m6) — post a scraping task, wait for
 * both workers' bids, counter-offer the cheaper one, accept the best final
 * price, receive the work and release escrow, then create a 1 NEAR
 * sub-mandate for worker-summarizer so it can autonomously pay through the
 * Vault and summarize via NEAR AI. Prints a clean colored recap with
 * explorer links at the end.
 *
 * Usage: npm run demo:m6
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { bold, cyan, dim, green, magenta, yellow } from './lib/colors.ts';
import {
  accountId, explorerAccount, formatNear, OWNER_ID, provider, readDeployments, view,
} from './lib/near.ts';

interface Mandate {
  id: number;
  owner: string;
  agent: string;
  parent: number | null;
  budget: string;
  spent: string;
  delegated: string;
  locked: string;
  active: boolean;
}
interface Task {
  id: number;
  mandate_id: number;
  poster: string;
  description: string;
  max_price: string;
  status: string;
  worker: string | null;
  price: string | null;
}
interface Bid {
  task_id: number;
  worker: string;
  price: string;
}

function waitForListening(label: string, proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not start within 20s`)), 20_000);
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (text.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited early with code ${code}`));
    });
  });
}

async function balance(id: string): Promise<bigint> {
  return BigInt((await provider.viewAccount({ accountId: id, blockQuery: { finality: 'final' } })).amount);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(bold('\n=== Meridian M6 demo: the agent marketplace ===\n'));

  const services: ChildProcess[] = [];
  const spawnService = (scriptPath: string): ChildProcess => {
    const proc = spawn('npx', ['tsx', scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    services.push(proc);
    return proc;
  };

  try {
    console.log(cyan('1. starting vendors/paid-api, worker-scraper, worker-summarizer...\n'));
    await waitForListening('paid-api', spawnService('vendors/paid-api/src/index.ts'));
    await waitForListening('worker-scraper', spawnService('vendors/worker-scraper/src/index.ts'));
    await waitForListening('worker-summarizer', spawnService('vendors/worker-summarizer/src/index.ts'));

    console.log(cyan('\n2. running the agent in marketplace mode (--m6)...\n'));
    const agent = spawn('npx', ['tsx', 'agent/src/index.ts', '--m6'], { stdio: 'inherit' });
    const [code] = await once(agent, 'exit');
    if (code !== 0) {
      console.error(`\nagent exited with code ${code}`);
      process.exitCode = typeof code === 'number' ? code : 1;
      return;
    }

    console.log(cyan('\n3. waiting for worker-summarizer to pay through its sub-mandate and summarize via NEAR AI...\n'));
    await sleep(10_000);

    console.log(bold('\n=== recap ===\n'));
    const d = readDeployments();
    const vaultId: string = d.vault.contractId;
    const mandateId: number = d.seed.mandateId;

    const mandates = await view<Mandate[]>(vaultId, 'get_mandates_by_owner', { owner: OWNER_ID });
    const sub = mandates
      .filter((m) => m.parent === mandateId && m.agent === accountId('workerSummarizer'))
      .sort((a, b) => b.id - a.id)[0];

    const tasks = await view<Task[]>(vaultId, 'get_tasks', { from: 0, limit: 1000 });
    const myTasks = tasks.filter((t) => t.poster === accountId('agent')).sort((a, b) => b.id - a.id);
    const task = myTasks[0];

    if (task) {
      const bids = await view<Bid[]>(vaultId, 'get_bids', { task_id: task.id });
      console.log(`${green('post_task')}    task ${task.id}: "${task.description}" (max ${task.max_price} yoctoNEAR)`);
      for (const b of bids) console.log(`${yellow('bid')}           ${b.worker} → ${b.price} yoctoNEAR`);
      console.log(`${green('accept_bid')}   worker ${task.worker} @ ${task.price} yoctoNEAR — status ${task.status}`);
      console.log(dim(`                ${explorerAccount(vaultId)}`));
    } else {
      console.log(yellow('No task found yet — the agent may not have posted one.'));
    }

    if (sub) {
      console.log(`${magenta('sub_mandate')}  id ${sub.id}: ${sub.budget} yoctoNEAR budget for ${sub.agent} (parent ${mandateId})`);
    } else {
      console.log(yellow('No sub-mandate found for worker-summarizer yet.'));
    }

    const ownerBal = await balance(OWNER_ID);
    const vaultBal = await balance(vaultId);
    console.log(`\n${bold('Owner')} ${OWNER_ID}: ${formatNear(ownerBal)}`);
    console.log(`${bold('Vault')} ${vaultId}: ${formatNear(vaultBal)}`);
    console.log(dim(`${explorerAccount(OWNER_ID)}  ${explorerAccount(vaultId)}`));

    console.log(bold('\n=== M6 demo complete ===\n'));
  } finally {
    for (const p of services) p.kill();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
