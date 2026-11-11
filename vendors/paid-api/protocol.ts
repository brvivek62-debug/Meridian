/**
 * The tiny HTTP-402 payment protocol shared between vendors/paid-api and
 * agent/. Kept as one file so both sides agree on the memo format: the nonce
 * the vendor issued in its 402 response must come back inside the memo of
 * the Vault.pay() call that pays for it, so the vendor can tie a specific
 * payment to a specific quote.
 */
export const MEMO_PREFIX = 'paid-api:';

export const buildMemo = (nonce: string): string => `${MEMO_PREFIX}${nonce}`;

export const parseNonce = (memo: string): string | null =>
  memo.startsWith(MEMO_PREFIX) ? memo.slice(MEMO_PREFIX.length) : null;

export const PAYMENT_TX_HEADER = 'x-payment-tx';
/** Who signed the payment transaction. Defaults to AGENT_ACCOUNT_ID server-side if absent. */
export const PAYMENT_FROM_HEADER = 'x-payment-from';

export interface PaymentRequired {
  price: string; // yoctoNEAR, as a string (NEAR amounts don't fit in a JS number)
  priceNear: string;
  payTo: string;
  memoNonce: string;
  vault: string;
  memo: string; // the exact memo string to pass to Vault.pay()
}
