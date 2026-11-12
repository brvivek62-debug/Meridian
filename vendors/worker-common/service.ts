/**
 * Shared scaffolding for the worker services (vendors/worker-scraper,
 * vendors/worker-summarizer): poll the Vault for open tasks posted by the
 * known agent, submit a bid, answer one counter-offer via HTTP (accept by
 * resubmitting a lower bid on-chain, or reject and keep the current one),
 * and deliver the work once a task is locked to this worker. Optionally
 * watches for a new active mandate being granted to this account (a
 * sub-mandate) and runs a callback once per mandate id.
 */
import express, { type Express } from 'express';
import { nearToYocto, teraToGas } from 'near-api-js';
import { account, explorerAccount, explorerTx, txHash, view } from '../../scripts/lib/near.ts';

export interface TaskView {
  id: number;
  mandate_id: number;
  poster: string;
  description: string;
  max_price: string;
  status: 'Open' | 'Locked' | 'Released' | 'Refunded';
  worker: string | null;
  price: string | null;
}

export interface MandateView {
  id: number;
  owner: string;
  agent: string;
  parent: number | null;
  active: boolean;
  budget: string;
  per_tx_cap: string;
  daily_cap: string;
  allowlist: string[];
  approval_threshold: string;
}

export interface WorkerConfig {
  accountId: string;
  vaultId: string;
  /** Only bid on open tasks posted by this account. */
  posterId: string;
  port: number;
  label: string;
  color: (s: string) => string;
  startPriceNear: `${number}`;
  minPriceNear: `${number}`;
  pollIntervalMs?: number;
  /** Produce the deliverable for a task this worker won. */
  onDeliver: (task: TaskView) => unknown;
  /** Called once per new active mandate granted to this account (e.g. a sub-mandate). */
  onMandateGranted?: (mandate: MandateView) => void;
  /** Owner id — required only if onMandateGranted is set. */
  ownerId?: string;
}

export function startWorkerService(cfg: WorkerConfig): void {
  const log = (s: string): void => console.log(`${cfg.color(`[${cfg.label}]`)} ${s}`);
  const bidded = new Set<number>();
  const counterDecisions = new Map<number, { accepted: boolean; priceNear: string }>();
  const grantedMandates = new Set<number>();

  async function bidOnOpenTasks(): Promise<void> {
    const tasks = await view<TaskView[]>(cfg.vaultId, 'get_tasks', { from: 0, limit: 100 });
    const price = nearToYocto(cfg.startPriceNear);
    for (const task of tasks) {
      if (task.status !== 'Open' || task.poster !== cfg.posterId || bidded.has(task.id)) continue;
      if (price > BigInt(task.max_price)) continue;
      bidded.add(task.id);
      const res = await account(cfg.accountId).callFunctionRaw({
        contractId: cfg.vaultId,
        methodName: 'submit_bid',
        args: { task_id: task.id, price: price.toString() },
        gas: teraToGas('30'),
      });
      log(`bid ${cfg.startPriceNear} NEAR on task ${task.id} ("${task.description}") — ${explorerTx(txHash(res))}`);
    }
  }

  async function watchMandates(): Promise<void> {
    if (!cfg.onMandateGranted || !cfg.ownerId) return;
    const mandates = await view<MandateView[]>(cfg.vaultId, 'get_mandates_by_owner', { owner: cfg.ownerId });
    for (const m of mandates) {
      if (m.agent === cfg.accountId && m.active && !grantedMandates.has(m.id)) {
        grantedMandates.add(m.id);
        log(`sub-mandate ${m.id} granted: ${m.budget} yoctoNEAR budget — ${explorerAccount(cfg.vaultId)}`);
        cfg.onMandateGranted(m);
      }
    }
  }

  const interval = setInterval(() => {
    bidOnOpenTasks().catch((e) => log(`poll error: ${e instanceof Error ? e.message : e}`));
    watchMandates().catch((e) => log(`mandate watch error: ${e instanceof Error ? e.message : e}`));
  }, cfg.pollIntervalMs ?? 1500);
  process.on('exit', () => clearInterval(interval));

  const app: Express = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true, account: cfg.accountId }));

  app.post('/counter-offer', async (req, res) => {
    const taskId = Number(req.body?.taskId);
    const priceNear = String(req.body?.priceNear ?? '');
    if (!Number.isFinite(taskId) || !priceNear) {
      res.status(400).json({ error: 'expected { taskId: number, priceNear: string }' });
      return;
    }

    const existing = counterDecisions.get(taskId);
    if (existing) {
      log(`counter-offer for task ${taskId} already answered — returning that decision`);
      res.json(existing);
      return;
    }

    const offered = nearToYocto(priceNear as `${number}`);
    const min = nearToYocto(cfg.minPriceNear);
    if (offered < min) {
      const decision = { accepted: false, priceNear: cfg.startPriceNear };
      counterDecisions.set(taskId, decision);
      log(`rejected counter ${priceNear} NEAR on task ${taskId} (below our minimum ${cfg.minPriceNear} NEAR) — bid stands`);
      res.json(decision);
      return;
    }

    try {
      const resTx = await account(cfg.accountId).callFunctionRaw({
        contractId: cfg.vaultId,
        methodName: 'submit_bid',
        args: { task_id: taskId, price: offered.toString() },
        gas: teraToGas('30'),
      });
      const decision = { accepted: true, priceNear };
      counterDecisions.set(taskId, decision);
      log(`accepted counter ${priceNear} NEAR on task ${taskId} — ${explorerTx(txHash(resTx))}`);
      res.json(decision);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/deliver/:taskId', async (req, res) => {
    const taskId = Number(req.params.taskId);
    const task = await view<TaskView | null>(cfg.vaultId, 'get_task', { task_id: taskId });
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (task.worker !== cfg.accountId) {
      res.status(403).json({ error: 'this task was not won by this worker' });
      return;
    }
    res.json(cfg.onDeliver(task));
  });

  app.listen(cfg.port, () => {
    log(`listening on http://localhost:${cfg.port} — account ${cfg.accountId}, bidding on tasks from ${cfg.posterId}`);
  });
}
