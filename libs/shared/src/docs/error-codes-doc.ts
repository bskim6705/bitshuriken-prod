import { ErrorCode } from '../constants/error-codes';

// Markdown error catalog for the API docs. Codes and names come from ErrorCode
// (single source of truth); this map only supplies the human-readable meaning.
// A code with no entry still renders (meaning "—") so drift stays visible.
const MEANINGS: Partial<Record<keyof typeof ErrorCode, string>> = {
  SUCCESS: 'Request succeeded.',
  INTERNAL_ERROR: 'Unexpected server-side error.',
  VALIDATION_ERROR: 'Request body or query failed validation.',
  NOT_FOUND: 'Resource does not exist.',
  UNAUTHORIZED: 'Authentication is missing or invalid.',
  FORBIDDEN: 'Authenticated, but not allowed to perform this action.',
  PARAM_REQUIRED: 'A required parameter was omitted.',
  INVALID_PARAMETER: 'A parameter has an invalid value.',

  USER_NOT_FOUND: 'No user matches the request.',
  USER_ALREADY_EXISTS: 'A user with this email already exists.',
  ACCOUNT_LOGIN_DISABLED: 'Sign-in is disabled for this account by an administrator.',
  ACCOUNT_TRADING_DISABLED: 'Trading is disabled for this account by an administrator.',
  ACCOUNT_WITHDRAWAL_DISABLED: 'Withdrawals are disabled for this account by an administrator.',

  WALLET_NOT_FOUND: 'No wallet for the requested asset.',
  INSUFFICIENT_BALANCE: 'Free balance is too low for the operation.',

  ORDER_NOT_FOUND: 'No order matches the id.',
  ORDER_ALREADY_CANCELED: 'Order is already canceled.',
  ORDER_ALREADY_FILLED: 'Order is already fully filled.',
  ORDER_NOT_OPEN: 'Order is not in an open state.',
  INVALID_ORDER_FIELDS: 'Order field combination is invalid for the order type.',
  INVALID_TIME_IN_FORCE: 'timeInForce is not valid for this order type.',
  INVALID_QTY: 'qty is missing, non-positive, or violates stepSize.',
  INVALID_PRICE: 'price is missing, non-positive, or violates tickSize.',
  MIN_NOTIONAL_NOT_MET: 'Order notional is below the symbol minimum.',
  MAX_NOTIONAL_EXCEEDED: 'Order notional exceeds the symbol maximum.',
  PRICE_OUT_OF_BAND: 'LIMIT price is outside the allowed price band.',
  ORDER_WOULD_TRIGGER_IMMEDIATELY: 'Stop order would trigger at the current price.',
  ORDER_REPLACE_REJECTED: 'Cancel-replace was rejected.',
  REDUCE_ONLY_REJECTED: 'reduceOnly order rejected (no opposing position).',
  REDUCE_ONLY_EXCEEDED: 'reduceOnly qty exceeds the open position size.',
  ORDER_DUPLICATE_CLIENT_ID: 'clientOrderId is already in use for this product.',
  MAX_NUM_ORDERS_EXCEEDED: 'Open-order count for this symbol exceeds the per-user maximum.',

  ORDER_LIST_NOT_FOUND: 'No order list matches the id.',
  ORDER_LIST_NOT_CANCELABLE: 'Order list is not in a cancelable state.',
  OCO_PRICE_INVALID: 'OCO price/stop relationship is invalid.',

  TICKER_NOT_FOUND: 'Unknown symbol for this market.',
  TICKER_ALREADY_EXISTS: 'Symbol already registered.',
  MARKET_DATA_NOT_FOUND: 'No market data available for the request.',
  MARK_PRICE_UNAVAILABLE: 'Mark price is not yet formed (futures only).',
  TICKER_NOT_TRADABLE: 'Symbol is not open for new orders (pending, halted, or delisted).',

  AUTH_REQUIRED: 'Endpoint requires authentication.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  INVALID_API_KEY: 'X-API-Key is unknown or revoked.',
  INVALID_SIGNATURE: 'HMAC signature does not match.',
  TIMESTAMP_OUT_OF_RECV_WINDOW: '|now - timestamp| exceeds recvWindow.',
  API_KEY_NOT_FOUND: 'No API key matches the id.',
  LISTEN_KEY_NOT_FOUND: 'listenKey is unknown or already expired.',
  API_KEY_NO_TRADE_PERMISSION: 'API key lacks the canTrade permission.',
  API_KEY_NO_READ_PERMISSION: 'API key lacks the canRead permission.',
  TWO_FACTOR_REQUIRED: 'A two-factor code is required to proceed.',
  INVALID_TWO_FACTOR_CODE: 'Two-factor code is incorrect or expired.',
  TWO_FACTOR_ALREADY_ENABLED: 'Two-factor auth is already enabled.',
  TWO_FACTOR_NOT_ENABLED: 'Two-factor auth is not enabled.',
  EMAIL_NOT_VERIFIED: 'Email address is not verified.',
  EMAIL_ALREADY_VERIFIED: 'Email address is already verified.',
  INVALID_OR_EXPIRED_TOKEN: 'Verification/reset token is invalid or expired.',
  ADMIN_REQUIRED: 'Endpoint requires an admin account.',

  POSITION_NOT_FOUND: 'No position for the symbol.',
  POSITION_LIQUIDATING: 'Position is being liquidated; action rejected.',
  INVALID_LEVERAGE: 'Leverage out of range, or position is non-empty.',
  INVALID_MARGIN_DELTA: 'marginDelta is zero or malformed.',
  MARGIN_DELTA_EXCEEDS_WITHDRAWABLE: 'Margin removal exceeds the withdrawable amount.',

  TRANSFER_PENDING_SETTLEMENT:
    'futures->spot withdrawal blocked by pending settlement or a LIQUIDATING position.',

  SUBACCOUNT_NOT_FOUND: 'No subaccount with this id under the current master account.',
  SUBACCOUNT_LIMIT_REACHED: 'Maximum number of subaccounts reached.',
  SUBACCOUNT_NESTING_FORBIDDEN: 'A subaccount cannot own subaccounts.',
};

// Ordered code ranges -> sidebar group. Order (40xxx) and OCO (41xxx) split.
const GROUPS: { label: string; min: number; max: number }[] = [
  { label: 'General', min: 0, max: 19999 },
  { label: 'User', min: 20000, max: 29999 },
  { label: 'Wallet', min: 30000, max: 39999 },
  { label: 'Order', min: 40000, max: 40999 },
  { label: 'Order list (OCO)', min: 41000, max: 41999 },
  { label: 'Ticker / market data', min: 50000, max: 59999 },
  { label: 'Auth / API key / 2FA / email', min: 60000, max: 69999 },
  { label: 'Futures position / margin', min: 70000, max: 79999 },
  { label: 'Transfer', min: 80000, max: 89999 },
  { label: 'Subaccount', min: 90000, max: 99999 },
];

/** Grouped markdown tables of the full ErrorCode catalog. */
export function renderErrorCodesMarkdown(): string {
  const entries = Object.entries(ErrorCode) as [keyof typeof ErrorCode, number][];
  return GROUPS.map((g) => {
    const rows = entries
      .filter(([, code]) => code >= g.min && code <= g.max)
      .sort((a, b) => a[1] - b[1])
      .map(([name, code]) => `| \`${code}\` | \`${name}\` | ${MEANINGS[name] ?? '—'} |`)
      .join('\n');
    return rows ? `### ${g.label}\n\n| Code | Name | Meaning |\n| --- | --- | --- |\n${rows}` : '';
  })
    .filter(Boolean)
    .join('\n\n');
}
