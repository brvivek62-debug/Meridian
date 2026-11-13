/**
 * Chain Signatures (S1): derive the agent's Ethereum Sepolia address and send
 * a signed Sepolia transaction via NEAR's MPC signer (`v1.signer-prod.testnet`).
 *
 * Two separate, narrowly-restricted NEAR identities are involved (see
 * scripts/setup-sepolia-agent.ts for how their keys are cut down):
 *
 *  - SEPOLIA_AGENT_ACCOUNT_ID: can call ONLY Vault.authorize_foreign_payment.
 *    This is the on-chain policy gate — caps, allowlist, budget, logged as a
 *    ForeignReceipt before anything else happens.
 *  - MPC_SIGNER_ACCOUNT_ID: can call ONLY the MPC contract's `sign`. This is
 *    what actually produces the Sepolia signature, once authorized.
 *
 * Nothing on NEAR links those two calls together — the MPC signer has no idea
 * whether a particular payload was ever authorized by the Vault. The link is
 * enforced entirely by this file's control flow: `payOnEthereum` always calls
 * `authorize_foreign_payment` first and only proceeds to `sign` if the result
 * is `Authorized`. See the README's trust-model section for why that matters
 * and what the fully on-chain-enforced version (the Vault calling the MPC
 * signer itself) would look like.
 */
import { chainAdapters, contracts } from 'chainsig.js';
import { teraToGas, type FinalExecutionOutcome } from 'near-api-js';
import { createPublicClient, http, parseEther, type PublicClient } from 'viem';
import { sepolia } from 'viem/chains';
import { account, explorerTx, readDeployments, requireEnv, txHash, txValue, view } from '../../scripts/lib/near.ts';

export const MPC_CONTRACT_ID = process.env.MPC_CONTRACT_ID ?? 'v1.signer-prod.testnet';
export const SEPOLIA_AGENT_ACCOUNT_ID = requireEnv('SEPOLIA_AGENT_ACCOUNT_ID');
export const MPC_SIGNER_ACCOUNT_ID = requireEnv('MPC_SIGNER_ACCOUNT_ID');
export const SEPOLIA_AGENT_WALLET_PATH = 'sepolia-agent-wallet';
export const SEPOLIA_DEMO_VENDOR_PATH = 'sepolia-demo-vendor';
export const sepoliaExplorerTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
export const sepoliaExplorerAddress = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;

const mpcContract = new contracts.ChainSignatureContract({ contractId: MPC_CONTRACT_ID, networkId: 'testnet' });

function publicClient(): PublicClient {
  return createPublicClient({ chain: sepolia, transport: http(requireEnv('SEPOLIA_RPC_URL')) }) as PublicClient;
}

/** Offline (no RPC) address + public key derivation — pure epsilon-derivation math. */
export async function deriveSepoliaAddress(predecessor: string, path: string): Promise<{ address: string; publicKey: string }> {
  const evm = new chainAdapters.evm.EVM({ publicClient: publicClient(), contract: mpcContract });
  return evm.deriveAddressAndPublicKey(predecessor, path);
}

/**
 * `signerAccount` bridge chainsig.js's MPC `sign()` needs: it hands us
 * {receiverId, actions} transactions to sign and send, and we do it with
 * MPC_SIGNER_ACCOUNT_ID's own restricted key (the only key that may call the
 * MPC contract at all).
 */
async function signAndSendTransactions({
  transactions,
}: {
  transactions: { signerId?: string; receiverId: string; actions: unknown[] }[];
}): Promise<FinalExecutionOutcome[]> {
  const signer = account(MPC_SIGNER_ACCOUNT_ID);
  const results = await Promise.all(
    transactions.map((t) => signer.signAndSendTransaction({ receiverId: t.receiverId, actions: t.actions as never })),
  );
  return results as unknown as FinalExecutionOutcome[];
}

export interface ForeignAuthResult {
  status: 'Authorized' | 'Blocked';
  receipt_id: number;
  reason: string | null;
}

/**
 * Authorize a foreign payment on the Vault (on-chain, logged either way), and
 * — only if Authorized — build, sign via the MPC, and broadcast the Sepolia
 * transaction. Returns the Vault's authorization result plus the Sepolia tx
 * hash when one was actually sent.
 */
export async function payOnEthereum(
  vaultId: string,
  mandateId: number,
  to: `0x${string}`,
  amountUsdCents: number,
  amountWeiStr: string,
  memo: string,
): Promise<{ auth: ForeignAuthResult; nearTx: string; sepoliaTx?: string }> {
  const authRes = await account(SEPOLIA_AGENT_ACCOUNT_ID).callFunctionRaw({
    contractId: vaultId,
    methodName: 'authorize_foreign_payment',
    args: { mandate_id: mandateId, chain: 'ethereum-sepolia', to, amount_usd_cents: amountUsdCents, memo },
    gas: teraToGas('30'),
  });
  const auth = txValue<ForeignAuthResult>(authRes);
  const nearTx = txHash(authRes);
  if (auth.status !== 'Authorized') {
    return { auth, nearTx };
  }

  const evm = new chainAdapters.evm.EVM({ publicClient: publicClient(), contract: mpcContract });
  const { address: from } = await deriveSepoliaAddress(MPC_SIGNER_ACCOUNT_ID, SEPOLIA_AGENT_WALLET_PATH);
  const { transaction, hashesToSign } = await evm.prepareTransactionForSigning({
    from: from as `0x${string}`,
    to,
    value: BigInt(amountWeiStr),
  });

  const signatures = await mpcContract.sign({
    payloads: hashesToSign,
    path: SEPOLIA_AGENT_WALLET_PATH,
    keyType: 'Ecdsa',
    signerAccount: { accountId: MPC_SIGNER_ACCOUNT_ID, signAndSendTransactions },
  });

  const signedTx = evm.finalizeTransactionSigning({ transaction, rsvSignatures: signatures });
  const { hash } = await evm.broadcastTx(signedTx);
  return { auth, nearTx, sepoliaTx: hash };
}

export async function getForeignPolicy(vaultId: string, mandateId: number) {
  return view<{
    allowlist: string[];
    per_tx_cap_usd_cents: number;
    daily_cap_usd_cents: number;
    budget_usd_cents: number;
    spent_usd_cents: number;
    spent_today_usd_cents: number;
  } | null>(vaultId, 'get_foreign_policy', { mandate_id: mandateId });
}

/** The sub-mandate `scripts/setup-sepolia-agent.ts` carved out for sepolia-agent. */
export function sepoliaMandateId(): number {
  const override = process.env.SEPOLIA_MANDATE_ID;
  if (override) return Number(override);
  const d = readDeployments();
  if (d.sepolia?.subMandateId === undefined) {
    throw new Error('No sepolia sub-mandate recorded. Run `npm run setup-sepolia-agent` first.');
  }
  return d.sepolia.subMandateId;
}

/** Vault id from deployments/testnet.json, for callers that don't already have it. */
export function vaultIdFromDeployments(): string {
  const d = readDeployments();
  if (!d.vault?.contractId) throw new Error('No Vault in deployments/testnet.json. Run `npm run deploy` first.');
  return d.vault.contractId;
}

/** LLM tool wrapper: pay a Sepolia address from the agent's own derived wallet. */
export async function payOnEthereumTool(args: { to: string; amount_eth: string; usd_cents: number; memo: string }): Promise<string> {
  const vaultId = vaultIdFromDeployments();
  const weiStr = parseEther(args.amount_eth as `${number}`).toString();
  const { auth, nearTx, sepoliaTx } = await payOnEthereum(
    vaultId,
    sepoliaMandateId(),
    args.to as `0x${string}`,
    args.usd_cents,
    weiStr,
    args.memo,
  );
  return JSON.stringify({
    status: auth.status,
    reason: auth.reason,
    nearTx,
    nearExplorer: explorerTx(nearTx),
    sepoliaTx,
    sepoliaExplorer: sepoliaTx ? sepoliaExplorerTx(sepoliaTx) : undefined,
  });
}

export async function getForeignReceipts(vaultId: string, mandateId: number) {
  return view<
    {
      id: number;
      mandate_id: number;
      chain: string;
      to: string;
      amount_usd_cents: number;
      memo: string;
      status: 'Authorized' | 'Blocked';
      reason: string | null;
      ts_ns: string;
    }[]
  >(vaultId, 'get_foreign_receipts', { mandate_id: mandateId });
}

export { explorerTx };
