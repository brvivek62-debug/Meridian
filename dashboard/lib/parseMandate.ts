/**
 * Turns a plain-English description of spending rules into the Vault's exact
 * mandate fields, via NEAR AI Cloud (JSON mode, no tools — this never signs
 * or submits anything itself). The dashboard always shows the result for the
 * owner to review and edit before create_mandate is ever called.
 */
import { config as loadEnv } from 'dotenv';
import OpenAI from 'openai';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env directly (not dashboard/.env*), same as lib/near.ts
// — this route doesn't import near.ts, so it can't rely on that module's load
// happening first. No-op on Vercel, where env vars come from the platform.
loadEnv({ path: join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), '.env') });

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} in .env (see .env.example).`);
  return v;
}

// Built lazily, on first real request, not at module load — a serverless
// build's page-data collection step imports this module without secrets
// present, and must not throw just from doing so.
let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: requireEnv('NEARAI_API_KEY'), baseURL: requireEnv('NEARAI_BASE_URL') });
  return _client;
}
// Deliberately not LLM_MODEL (used by the M5/M6 agent's tool-calling loop):
// this route is a single one-shot JSON call, no tools, and the fastest NEAR
// AI Cloud model that handles JSON well for this shape is a different pick.
// See .env.example for the benchmark that led to this default.
function model(): string {
  return process.env.PARSE_MANDATE_MODEL || 'anthropic/claude-haiku-5-5';
}

export interface ParsedMandate {
  budgetNear: string;
  perTxCapNear: string;
  dailyCapNear: string;
  allowlist: string[];
  approvalThresholdNear: string;
  notes: string[];
}

const SYSTEM_PROMPT = [
  "You convert a plain-English description of spending rules for an AI agent's NEAR wallet mandate into exact",
  'structured fields. Output strictly valid JSON, matching this schema exactly:',
  '{ "budgetNear": string, "perTxCapNear": string, "dailyCapNear": string, "allowlist": string[], "approvalThresholdNear": string, "notes": string[] }',
  'All *Near fields are plain decimal NEAR amounts as strings (e.g. "0.5"), never yoctoNEAR and never with a unit',
  'suffix. allowlist is a list of NEAR account ids (e.g. "vendor.testnet"); use an empty array only if the',
  'description does not restrict spending to specific vendors — an empty allowlist means ANY vendor is allowed,',
  'so only use that when the user clearly wants no restriction. If a field is ambiguous or unstated, choose a',
  'reasonable, conservative default and explain the assumption in notes. If the requested caps or threshold would',
  'exceed the requested budget, or other numbers look inconsistent, keep the numbers the user gave (do not',
  'silently clamp them) but add a clear warning about it to notes so a human reviews it before anything is',
  'created. Never invent account ids that were not mentioned or clearly implied.',
].join(' ');

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export async function parseMandateDescription(description: string): Promise<ParsedMandate> {
  const completion = await client().chat.completions.create({
    model: model(),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: description },
    ],
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error('no content in LLM response');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('the model did not return valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the model did not return a JSON object');
  const p = parsed as Record<string, unknown>;

  const fields: (keyof Omit<ParsedMandate, 'notes' | 'allowlist'>)[] = ['budgetNear', 'perTxCapNear', 'dailyCapNear', 'approvalThresholdNear'];
  for (const f of fields) {
    if (typeof p[f] !== 'string' || !/^\d+(\.\d+)?$/.test(p[f] as string)) {
      throw new Error(`the model's "${f}" was not a plain decimal NEAR amount`);
    }
  }
  if (!isStringArray(p.allowlist)) throw new Error('the model\'s "allowlist" was not a list of strings');
  const notes = isStringArray(p.notes) ? p.notes : [];

  return {
    budgetNear: p.budgetNear as string,
    perTxCapNear: p.perTxCapNear as string,
    dailyCapNear: p.dailyCapNear as string,
    allowlist: p.allowlist as string[],
    approvalThresholdNear: p.approvalThresholdNear as string,
    notes,
  };
}
