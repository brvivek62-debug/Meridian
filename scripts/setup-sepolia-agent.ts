/**
 * S1 setup: provision the two narrow identities the cross-chain payment path
 * needs, carve out a sub-mandate for them, and set its foreign-payment policy.
 *
 * A NEAR function-call access key is scoped to exactly one receiver contract,
 * so this needs two separate accounts (same least-privilege pattern as
 * scripts/setup-agent-key.ts, just split across two receivers):
 *
 *  - sepolia-agent.<owner>.testnet: restricted to the Vault, and can call
 *    ONLY `authorize_foreign_payment` — nothing else, not even `pay`.
 *  - mpc-signer.<owner>.testnet: restricted to the Chain Signatures MPC
 *    contract (MPC_CONTRACT_ID), and can call ONLY `sign`.
 *
 * Neither key can touch the other's contract. Nothing on NEAR links the two:
 * our own TypeScript code (agent/src/chainSig.ts) is what calls Vault.
 * authorize_foreign_payment first and only then asks mpc-signer to request a
 * signature — see the README's trust-model section for why that matters.
 *
 * Steps:
 *  1. Restrict both accounts' keys (idempotent, via scripts/lib/keys.ts).
 *  2. The root mandate's agent creates a sub-mandate for sepolia-agent (same
 *     NEAR-denominated budget/caps every mandate needs, even though this one
 *     spends NEAR through neither `pay` nor escrow — the actual foreign caps
 *     live in the policy set in step 3).
 *  3. The owner sets that sub-mandate's foreign-payment policy: an allowlist
 *     of exactly one Sepolia address (the demo vendor, derived in step 4) and
 *     caps in USD cents.
 *  4. Derive the agent's own Sepolia wallet and the demo vendor's Sepolia
 *     address (pure offline math — chainsig.js's epsilon-derivation needs no
 *     network call when MPC_CONTRACT_ID is a known deployment's contract id).
 *
 * Usage: npm run setup-sepolia-agent
 */
import { nearToYocto, teraToGas } from 'near-api-js';
import { deriveSepoliaAddress, SEPOLIA_AGENT_WALLET_PATH, SEPOLIA_DEMO_VENDOR_PATH } from '../agent/src/chainSig.ts';
import { account, accountId, explorerTx, ownerTx, readDeployments, txHash, txValue, view, writeDeployments } from './lib/near.ts';
import { restrictToVault } from './lib/keys.ts';

const MPC_CONTRACT_ID = process.env.MPC_CONTRACT_ID ?? 'v1.signer-prod.testnet';
const SEPOLIA_AGENT_METHODS = ['authorize_foreign_payment'];
const MPC_SIGNER_METHODS = ['sign'];

async function main() {
  const d = readDeployments();
  const vaultId: string | undefined = d.vault?.contractId;
  const rootMandateId: number | undefined = d.seed?.mandateId;
  if (!vaultId) throw new Error('No Vault in deployments/testnet.json. Run `npm run deploy` first.');
  if (rootMandateId === undefined) throw new Error('No seed mandate in deployments/testnet.json. Run `npm run seed` first.');

  console.log('=== 1. restrict keys ===');
  console.log('\n--- sepolia-agent (Vault) ---');
  await restrictToVault(accountId('sepoliaAgent'), vaultId, SEPOLIA_AGENT_METHODS);
  console.log('\n--- mpc-signer (MPC contract) ---');
  await restrictToVault(accountId('mpcSigner'), MPC_CONTRACT_ID, MPC_SIGNER_METHODS);

  console.log('\n=== 2. sub-mandate for sepolia-agent ===');
  const rootAgent = accountId('agent');
  const sepoliaAgentId = accountId('sepoliaAgent');
  let subMandateId: number = d.sepolia?.subMandateId;
  if (subMandateId === undefined) {
    const root = await view<{ agent: string; children: number[] }>(vaultId, 'get_mandate', { mandate_id: rootMandateId });
    const existingChild = (
      await Promise.all(root.children.map(async (id) => ({ id, m: await view<{ agent: string }>(vaultId, 'get_mandate', { mandate_id: id }) })))
    ).find((c) => c.m.agent === sepoliaAgentId);
    if (existingChild) {
      subMandateId = existingChild.id;
      console.log(`✓ sub-mandate ${subMandateId} for ${sepoliaAgentId} already exists`);
    } else {
      const args = {
        parent_id: rootMandateId,
        agent: sepoliaAgentId,
        budget: nearToYocto('0.3').toString(),
        per_tx_cap: nearToYocto('0.2').toString(),
        daily_cap: nearToYocto('0.3').toString(),
        allowlist: [accountId('paidApi')],
        approval_threshold: nearToYocto('0.25').toString(),
      };
      const res = await account(rootAgent).callFunctionRaw({
        contractId: vaultId,
        methodName: 'create_sub_mandate',
        args,
        gas: teraToGas('30'),
      });
      subMandateId = txValue<number>(res);
      console.log(`+ created sub-mandate ${subMandateId} for ${sepoliaAgentId}  ${explorerTx(txHash(res))}`);
    }
  } else {
    console.log(`✓ sub-mandate ${subMandateId} already recorded`);
  }

  console.log('\n=== 3. derive Sepolia addresses (offline) ===');
  const mpcSignerId = accountId('mpcSigner');
  const wallet = await deriveSepoliaAddress(mpcSignerId, SEPOLIA_AGENT_WALLET_PATH);
  const vendor = await deriveSepoliaAddress(mpcSignerId, SEPOLIA_DEMO_VENDOR_PATH);
  console.log(`  agent wallet: ${wallet.address}  (path "${SEPOLIA_AGENT_WALLET_PATH}")`);
  console.log(`  demo vendor:  ${vendor.address}  (path "${SEPOLIA_DEMO_VENDOR_PATH}")`);

  console.log('\n=== 4. set foreign-payment policy on the sub-mandate ===');
  const existingPolicy = await view<{ allowlist: string[] } | null>(vaultId, 'get_foreign_policy', { mandate_id: subMandateId });
  if (existingPolicy && existingPolicy.allowlist.includes(vendor.address.toLowerCase())) {
    console.log(`✓ foreign policy on mandate ${subMandateId} already allows ${vendor.address}`);
  } else {
    const policyArgs = {
      mandate_id: subMandateId,
      allowlist: [vendor.address],
      per_tx_cap_usd_cents: 500,
      daily_cap_usd_cents: 1000,
      budget_usd_cents: 2000,
    };
    const { txHash: hash } = ownerTx([
      'contract', 'call-function', 'as-transaction', vaultId, 'set_foreign_policy',
      'json-args', JSON.stringify(policyArgs),
      'prepaid-gas', '30 Tgas',
      'attached-deposit', '0 NEAR',
    ]);
    console.log(`+ set foreign policy on mandate ${subMandateId}: allowlist=[${vendor.address}], 5 USD/tx, 10 USD/day, 20 USD total  ${explorerTx(hash)}`);
  }

  d.sepolia = {
    subMandateId,
    sepoliaAgentId,
    mpcSignerId,
    mpcContractId: MPC_CONTRACT_ID,
    agentWallet: { address: wallet.address, path: SEPOLIA_AGENT_WALLET_PATH },
    demoVendor: { address: vendor.address, path: SEPOLIA_DEMO_VENDOR_PATH },
    setupAt: new Date().toISOString(),
  };
  writeDeployments(d);
  console.log('\nWrote deployments/testnet.json');

  console.log(`\n=== fund this address on Sepolia, then run the demo ===`);
  console.log(`  ${wallet.address}`);
  console.log(`  Needs only a small amount of Sepolia ETH (e.g. 0.01 ETH) to cover one small test payment + gas.`);
  console.log(`  A faucet that doesn't require holding mainnet ETH: https://cloud.google.com/application/web3/faucet/ethereum/sepolia`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
