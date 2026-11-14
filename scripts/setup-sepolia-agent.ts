/**
 * S1 setup: provision the two identities the cross-chain payment path needs,
 * carve out a sub-mandate for them, and set its foreign-payment policy.
 *
 *  - sepolia-agent.<owner>.testnet: restricted to the Vault, and can call
 *    ONLY `authorize_foreign_payment` — nothing else, not even `pay`. This is
 *    the on-chain policy gate (allowlist, caps, budget), enforced by a NEAR
 *    function-call access key, the same way AGENT_ACCOUNT_ID is restricted
 *    to the Vault in scripts/setup-agent-key.ts.
 *  - mpc-signer.<owner>.testnet: calls the Chain Signatures MPC contract's
 *    `sign`. This one keeps its full-access key — chainsig.js's `sign()`
 *    action always attaches a 1 yoctoNEAR deposit, and NEAR's protocol
 *    disallows ANY deposit on a function call signed by a function-call
 *    (restricted) key, full stop. So nothing stops this specific account
 *    from doing anything else a full-access key can do; what keeps it narrow
 *    is only our own code (agent/src/chainSig.ts always calls Vault.
 *    authorize_foreign_payment first and only signs if that's Authorized),
 *    not a NEAR-enforced guarantee. Its balance is trivial testnet funds.
 *    See the README's trust-model section for why this matters.
 *
 * Steps:
 *  1. Restrict sepolia-agent's key (idempotent, via scripts/lib/keys.ts).
 *  2. The root mandate's agent creates a sub-mandate for sepolia-agent (same
 *     NEAR-denominated budget/caps every mandate needs, even though this one
 *     spends NEAR through neither `pay` nor escrow — the actual foreign caps
 *     live in the policy set in step 4).
 *  3. Derive the agent's own Sepolia wallet and the demo vendor's Sepolia
 *     address (pure offline math — chainsig.js's epsilon-derivation needs no
 *     network call when MPC_CONTRACT_ID is a known deployment's contract id).
 *  4. The owner sets the sub-mandate's foreign-payment policy: an allowlist
 *     of exactly the demo vendor's address and caps in USD cents.
 *
 * Usage: npm run setup-sepolia-agent
 */
import { nearToYocto, teraToGas } from 'near-api-js';
import { deriveSepoliaAddress, SEPOLIA_AGENT_WALLET_PATH, SEPOLIA_DEMO_VENDOR_PATH } from '../agent/src/chainSig.ts';
import { account, accountId, explorerTx, ownerTx, readDeployments, txHash, txValue, view, writeDeployments } from './lib/near.ts';
import { restrictToVault } from './lib/keys.ts';

const MPC_CONTRACT_ID = process.env.MPC_CONTRACT_ID ?? 'v1.signer-prod.testnet';
const SEPOLIA_AGENT_METHODS = ['authorize_foreign_payment'];

async function main() {
  const d = readDeployments();
  const vaultId: string | undefined = d.vault?.contractId;
  const rootMandateId: number | undefined = d.seed?.mandateId;
  if (!vaultId) throw new Error('No Vault in deployments/testnet.json. Run `npm run deploy` first.');
  if (rootMandateId === undefined) throw new Error('No seed mandate in deployments/testnet.json. Run `npm run seed` first.');

  console.log('=== 1. restrict sepolia-agent\'s key to the Vault ===');
  await restrictToVault(accountId('sepoliaAgent'), vaultId, SEPOLIA_AGENT_METHODS);
  console.log(`\n(mpc-signer keeps its full-access key — see this file's header comment for why.)`);

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
