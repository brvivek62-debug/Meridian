/**
 * The agent entrypoint. Runs an LLM tool-calling loop on NEAR AI Cloud that can
 * check its Vault-enforced budget and call paid APIs, paying through the Vault
 * automatically on a 402.
 *
 * Usage: npm run agent -- "research question"
 */
import 'dotenv/config';
import { runAgent } from './llm.ts';

const DEFAULT_QUESTION =
  'Using the paid research API at ' +
  (process.env.PAID_API_URL ?? 'http://localhost:4021') +
  '/data?q=near+agent+wallets, summarize the key security properties of delegated AI agent wallets.';

const question = process.argv.slice(2).join(' ').trim() || DEFAULT_QUESTION;

async function main() {
  console.log(`[agent] question: ${question}\n`);
  const answer = await runAgent(question, (line) => console.log(line));
  console.log(`\n[agent] answer:\n${answer}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
