/**
 * EXPERIMENTAL (S1, feature-frozen): one allowed Chain Signatures payment on
 * Ethereum Sepolia, and one blocked attempt (destination not on the
 * mandate's foreign-payment allowlist).
 *
 * As of the feature freeze, the Vault-side half of this (authorize_foreign_
 * payment: policy check, allowlist, caps, on-chain receipt) is implemented
 * and proven on testnet — see README trust-model section and the Deployments
 * table for real tx links. The MPC-signing half (deriving the Sepolia address
 * and actually broadcasting a signed Sepolia tx via v1.signer-prod.testnet)
 * has not completed a full run: it needs the derived agent wallet funded
 * with Sepolia testnet ETH from a faucet, which hasn't happened yet. Do not
 * treat a run of this script as a finished cross-chain payment until it logs
 * a real sepoliaTx. Nothing here is wired into the dashboard or npm run demo.
 *
 * Requires the agent's derived Sepolia wallet (printed by
 * `npm run setup-sepolia-agent`) to hold a small amount of Sepolia ETH — this
 * script checks the balance first and stops with funding instructions if it's
 * empty, rather than spending gas on a transaction that would just fail.
 *
 * Usage: npm run demo:s1
 */
import { createPublicClient, formatEther, http, parseEther } from 'viem';
import { sepolia } from 'viem/chains';
import {
  explorerTx, getForeignPolicy, getForeignReceipts, MPC_SIGNER_ACCOUNT_ID,
  payOnEthereum, SEPOLIA_AGENT_WALLET_PATH, sepoliaExplorerAddress, sepoliaExplorerTx,
} from '../agent/src/chainSig.ts';
import { readDeployments, requireEnv, writeDeployments } from './lib/near.ts';

const PAYMENT_WEI = parseEther('0.0003');
const PAYMENT_USD_CENTS = 300; // within the 500/tx, 1000/day, 2000 total caps set by setup-sepolia-agent.ts
const ATTACKER_ADDRESS = '0x000000000000000000000000000000000000ee' as const; // not on the allowlist

async function main() {
  const d = readDeployments();
  const vaultId: string | undefined = d.vault?.contractId;
  const sub = d.sepolia;
  if (!vaultId || !sub) throw new Error('Run `npm run setup-sepolia-agent` first.');
  const mandateId: number = sub.subMandateId;
  const walletAddress: `0x${string}` = sub.agentWallet.address;
  const vendorAddress: `0x${string}` = sub.demoVendor.address;

  const publicClient = createPublicClient({ chain: sepolia, transport: http(requireEnv('SEPOLIA_RPC_URL')) });
  const balance = await publicClient.getBalance({ address: walletAddress });
  console.log(`Agent Sepolia wallet: ${walletAddress}  ${sepoliaExplorerAddress(walletAddress)}`);
  console.log(`Balance: ${formatEther(balance)} ETH`);
  if (balance < PAYMENT_WEI + parseEther('0.0001')) {
    console.log(`\nNeeds at least ${formatEther(PAYMENT_WEI + parseEther('0.0001'))} ETH (payment + gas headroom) to run this demo.`);
    console.log('Fund it from a faucet that does not require holding mainnet ETH, e.g.:');
    console.log('  https://cloud.google.com/application/web3/faucet/ethereum/sepolia');
    process.exitCode = 1;
    return;
  }

  console.log(`\nMPC signer: ${MPC_SIGNER_ACCOUNT_ID} (derivation path "${SEPOLIA_AGENT_WALLET_PATH}")`);
  const policyBefore = await getForeignPolicy(vaultId, mandateId);
  console.log(`Foreign policy before: ${JSON.stringify(policyBefore)}`);

  console.log(`\n=== 1. allowed payment: ${formatEther(PAYMENT_WEI)} ETH → ${vendorAddress} ===`);
  const allowed = await payOnEthereum(vaultId, mandateId, vendorAddress, PAYMENT_USD_CENTS, PAYMENT_WEI.toString(), 'S1 demo: allowed payment');
  console.log(`  Vault.authorize_foreign_payment → ${allowed.auth.status}  ${explorerTx(allowed.nearTx)}`);
  if (allowed.sepoliaTx) console.log(`  Sepolia tx: ${allowed.sepoliaTx}  ${sepoliaExplorerTx(allowed.sepoliaTx)}`);
  else console.log(`  reason: ${allowed.auth.reason}`);

  console.log(`\n=== 2. blocked attempt: destination ${ATTACKER_ADDRESS} is not on the allowlist ===`);
  const blocked = await payOnEthereum(vaultId, mandateId, ATTACKER_ADDRESS, PAYMENT_USD_CENTS, PAYMENT_WEI.toString(), 'S1 demo: attacker — should be blocked');
  console.log(`  Vault.authorize_foreign_payment → ${blocked.auth.status}  ${explorerTx(blocked.nearTx)}`);
  console.log(`  reason: ${blocked.auth.reason}`);
  if (blocked.sepoliaTx) throw new Error(`SECURITY BUG: a Sepolia tx was sent for a Blocked authorization: ${blocked.sepoliaTx}`);

  const receipts = await getForeignReceipts(vaultId, mandateId);
  console.log(`\nForeign receipts on mandate ${mandateId}: ${receipts.map((r) => r.status).join(', ')}`);

  d.sepolia.demoRuns = {
    allowed: { nearTx: allowed.nearTx, sepoliaTx: allowed.sepoliaTx, to: vendorAddress, amountWei: PAYMENT_WEI.toString() },
    blocked: { nearTx: blocked.nearTx, to: ATTACKER_ADDRESS, reason: blocked.auth.reason },
    ranAt: new Date().toISOString(),
  };
  writeDeployments(d);
  console.log('\nWrote deployments/testnet.json');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
