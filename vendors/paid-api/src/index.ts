/**
 * vendors/paid-api — the HTTP-402 side of the demo.
 *
 * GET /data?q=... with no valid X-Payment-Tx header → 402 with
 * { price, payTo, memoNonce }. With the header, verifies through NEAR
 * testnet RPC — not by trusting the client — that the transaction:
 *   1. was sent to the Vault contract (receiver_id === VAULT_CONTRACT_ID)
 *   2. called `pay` with `to` === this vendor's own account
 *   3. carries the nonce this server issued, inside the memo
 *   4. actually succeeded on-chain (the Vault's own ActionResult says "Paid")
 *   5. paid at least the asking price
 * and rejects a tx hash it has already consumed. Only then does it return data.
 *
 * Usage: npm run paid-api
 */
import 'dotenv/config';
import express from 'express';
import { nearToYocto } from 'near-api-js';
import { randomUUID } from 'node:crypto';
import { provider, requireEnv } from '../../../scripts/lib/near.ts';
import { buildMemo, parseNonce, PAYMENT_FROM_HEADER, PAYMENT_TX_HEADER, type PaymentRequired } from '../protocol.ts';

const PORT = Number(process.env.PAID_API_PORT ?? 4021);
const PRICE_NEAR = process.env.PAID_API_PRICE_NEAR ?? '0.3';
const PRICE_YOCTO = nearToYocto(PRICE_NEAR as `${number}`);
const VAULT_ID = requireEnv('VAULT_CONTRACT_ID');
const PAID_API_ID = requireEnv('PAID_API_ACCOUNT_ID');
const DEFAULT_PAYER = process.env.AGENT_ACCOUNT_ID;

/** Nonces this server has issued and not yet consumed by a verified payment. */
const issuedNonces = new Set<string>();
/** Tx hashes already used to pay — replaying one is rejected even if it's valid. */
const usedTxHashes = new Set<string>();

function quote(): PaymentRequired {
  const nonce = randomUUID();
  issuedNonces.add(nonce);
  return {
    price: PRICE_YOCTO.toString(),
    priceNear: `${PRICE_NEAR} NEAR`,
    payTo: PAID_API_ID,
    memoNonce: nonce,
    vault: VAULT_ID,
    memo: buildMemo(nonce),
  };
}

type FunctionCallActionView = { FunctionCall: { method_name: string; args: string; deposit: string } };

function decodeArgs(base64Args: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(base64Args, 'base64').toString('utf8'));
}

/** Verifies a payment tx against our own records. Returns a reason string on failure, or null if it checks out. */
async function verifyPayment(txHash: string, payer: string): Promise<{ reason: string } | { receiptId: unknown }> {
  if (usedTxHashes.has(txHash)) return { reason: 'this payment transaction has already been used' };

  let res: Awaited<ReturnType<typeof provider.viewTransactionStatus>>;
  try {
    res = await provider.viewTransactionStatus({ txHash, accountId: payer, waitUntil: 'FINAL' });
  } catch (e) {
    return { reason: `could not look up transaction ${txHash}: ${e instanceof Error ? e.message : e}` };
  }

  const tx = (res as any).transaction;
  if (tx?.receiver_id !== VAULT_ID) {
    return { reason: `transaction was not sent to the Vault (${VAULT_ID})` };
  }
  const payAction = (tx.actions as FunctionCallActionView[]).find(
    (a) => 'FunctionCall' in a && a.FunctionCall.method_name === 'pay',
  );
  if (!payAction) return { reason: 'transaction does not call Vault.pay' };

  const args = decodeArgs(payAction.FunctionCall.args);
  if (args.to !== PAID_API_ID) return { reason: `payment was not made to ${PAID_API_ID}` };

  const amount = BigInt(String(args.amount));
  if (amount < PRICE_YOCTO) return { reason: `amount ${amount} is below the price ${PRICE_YOCTO}` };

  const nonce = parseNonce(String(args.memo ?? ''));
  if (!nonce || !issuedNonces.has(nonce)) {
    return { reason: 'memo does not carry a nonce this server issued (or it was already consumed)' };
  }

  const status = (res as any).status;
  if (status?.Failure) return { reason: `Vault.pay transaction failed: ${JSON.stringify(status.Failure)}` };
  if (!status?.SuccessValue) return { reason: 'no result value from Vault.pay' };
  const result = JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString('utf8'));
  if (result.status !== 'Paid') {
    return { reason: `Vault.pay did not succeed: status=${result.status}${result.reason ? ` (${result.reason})` : ''}` };
  }

  // All checks passed — consume the nonce and the tx hash so neither can be replayed.
  issuedNonces.delete(nonce);
  usedTxHashes.add(txHash);
  return { receiptId: result.receipt_id };
}

const app = express();

app.get('/data', async (req, res) => {
  const q = String(req.query.q ?? '');
  const txHash = req.header(PAYMENT_TX_HEADER);
  const payer = req.header(PAYMENT_FROM_HEADER) ?? DEFAULT_PAYER;

  if (!txHash) {
    console.log(`[paid-api] GET /data?q=${JSON.stringify(q)} — no payment, returning 402`);
    res.status(402).json(quote());
    return;
  }
  if (!payer) {
    res.status(400).json({ error: `no ${PAYMENT_FROM_HEADER} header and AGENT_ACCOUNT_ID is not set` });
    return;
  }

  const check = await verifyPayment(txHash, payer);
  if ('reason' in check) {
    console.log(`[paid-api] GET /data?q=${JSON.stringify(q)} — payment rejected: ${check.reason}`);
    res.status(402).json({ error: check.reason, ...quote() });
    return;
  }

  console.log(`[paid-api] GET /data?q=${JSON.stringify(q)} — payment verified (tx ${txHash}, receipt ${check.receiptId}), returning data`);
  res.json({
    query: q,
    verifiedTx: txHash,
    receiptId: check.receiptId,
    results: [
      { title: `Mock research result for "${q}"`, snippet: 'This is mock data from vendors/paid-api, returned only after a verified Vault payment.', score: 0.97 },
      { title: 'Meridian: delegated financial authority for agents', snippet: 'Funds move only through the on-chain Vault, policy-checked every time.', score: 0.91 },
    ],
  });
});

app.get('/health', (_req, res) => res.json({ ok: true, vault: VAULT_ID, payTo: PAID_API_ID, priceNear: PRICE_NEAR }));

app.listen(PORT, () => {
  console.log(`[paid-api] listening on http://localhost:${PORT} — price ${PRICE_NEAR} NEAR, payTo ${PAID_API_ID}, vault ${VAULT_ID}`);
});
