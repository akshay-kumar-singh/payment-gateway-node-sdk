/**
 * payment-gateway-node-sdk — the payment gateway server SDK for Node.
 *
 * This runs on YOUR server and holds your secret key. It must never be imported into
 * browser code: the secret can create charges and issue refunds.
 *
 *   const gateway = new PaymentGateway({ clientId, clientSecret, environment: 'sandbox' });
 *   const order = await gateway.orders.create({ ... });
 *   // send order.paymentSessionId to the browser
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  PaymentGatewayError,
  type CreateOrderRequest, type Environment, type Order,
  type Payment, type Refund, type WebhookEvent,
  type ListOrdersOptions, type Page,
} from './types.js';

export * from './types.js';

// This test gateway is a single deployment, so both environments resolve to it. A
// real gateway would have genuinely separate sandbox and production hosts.
const HOSTS: Record<Environment, string> = {
  sandbox: 'https://payment-gateway-api-1juk.onrender.com',
  production: 'https://payment-gateway-api-1juk.onrender.com',
};

export interface PaymentGatewayConfig {
  clientId: string;
  clientSecret: string;
  environment?: Environment;
  /** Point at a locally running gateway while developing. */
  baseUrl?: string;
  /** Milliseconds. Default 30s. */
  timeout?: number;
  /** Retries after the first attempt, for failures worth retrying. Default 2. */
  maxRetries?: number;
  /** First backoff delay in ms; doubles each attempt. Default 300. */
  retryBaseMs?: number;
}

export class PaymentGateway {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly config: PaymentGatewayConfig) {
    if (!config?.clientId || !config?.clientSecret) {
      throw new Error('payment-gateway-node-sdk: clientId and clientSecret are required');
    }
    const env = config.environment ?? 'sandbox';
    this.baseUrl = (config.baseUrl ?? HOSTS[env]).replace(/\/$/, '');
    this.timeout = config.timeout ?? 30_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBaseMs = config.retryBaseMs ?? 300;
  }

  /* --------------------------------------------------------------- orders */

  orders = {
    create: async (req: CreateOrderRequest): Promise<Order> => {
      if (!(req.orderAmount > 0)) throw new Error('payment-gateway-node-sdk: orderAmount must be greater than 0');
      if (!req.customerDetails?.customerPhone) {
        throw new Error('payment-gateway-node-sdk: customerDetails.customerPhone is required');
      }
      const orderId = req.orderId ?? `order_${randomUUID()}`;
      return this.request<Order>('POST', '/pg/orders', {
        // Money crosses the wire as integer paise. Floats lose fractions of a rupee.
        order_id: orderId,
        order_amount_paise: Math.round(req.orderAmount * 100),
        order_currency: req.orderCurrency ?? 'INR',
        customer_details: {
          customer_id: req.customerDetails.customerId,
          customer_phone: req.customerDetails.customerPhone,
          customer_email: req.customerDetails.customerEmail,
          customer_name: req.customerDetails.customerName,
        },
        order_meta: { return_url: req.returnUrl },
        order_note: req.orderNote,
        order_tags: req.orderTags,
      }, orderId);
    },

    /** The only trustworthy way to know an order is paid. Check before you ship. */
    /**
     * One page of orders, newest first.
     *
     * Cursor-based rather than offset-based: a new order arriving while you page
     * cannot shift rows along and make you skip one.
     */
    all: (options: ListOrdersOptions = {}): Promise<Page<Order>> => this.listOrders(options),

    /**
     * Every order, fetched a page at a time.
     *
     *   for await (const order of gateway.orders.each()) { ... }
     *
     * Use this instead of a large limit: it holds one page in memory at a time,
     * and stops the moment you break out of the loop.
     */
    each: (options: { limit?: number } = {}): AsyncGenerator<Order> => this.eachOrder(options),

    fetch: (orderId: string): Promise<Order> =>
      this.request<Order>('GET', `/pg/orders/${encodeURIComponent(orderId)}`),

    payments: (orderId: string): Promise<Payment[]> =>
      this.request<Payment[]>('GET', `/pg/orders/${encodeURIComponent(orderId)}/payments`),
  };

  /* -------------------------------------------------------------- payments */

  payments = {
    fetch: (paymentId: string): Promise<Payment> =>
      this.request<Payment>('GET', `/pg/payments/${encodeURIComponent(paymentId)}`),
  };

  /* --------------------------------------------------------------- refunds */

  refunds = {
    create: (orderId: string, opts: { refundAmount: number; refundId?: string; refundNote?: string }): Promise<Refund> =>
      this.request<Refund>('POST', `/pg/orders/${encodeURIComponent(orderId)}/refunds`, {
        refund_id: opts.refundId ?? `refund_${randomUUID()}`,
        refund_amount_paise: Math.round(opts.refundAmount * 100),
        refund_note: opts.refundNote,
      }, opts.refundId),
  };

  /* -------------------------------------------------------------- webhooks */

  webhooks = {
    /**
     * Verify a webhook and return the parsed event.
     *
     * Pass the RAW request body, not a parsed object — parsing and re-serialising
     * changes the bytes and every signature will fail. In Express:
     *   app.post('/webhook', express.raw({ type: 'application/json' }), ...)
     *
     * Throws on a bad signature, so you cannot forget to check the result.
     */
    verify: (rawBody: string | Buffer, signature: string, timestamp: string): WebhookEvent => {
      if (!signature || !timestamp) {
        throw new PaymentGatewayError('INVALID_SIGNATURE', 'Missing signature or timestamp header', 400);
      }
      // Replay guard: the timestamp is inside the signed payload, so an attacker
      // cannot resend yesterday's "payment succeeded" with a fresh clock.
      const ageMs = Math.abs(Date.now() - Number(timestamp) * 1000);
      if (!Number.isFinite(ageMs) || ageMs > 5 * 60_000) {
        throw new PaymentGatewayError('SIGNATURE_EXPIRED', 'Webhook timestamp is outside the 5 minute window', 400);
      }

      const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      const expected = createHmac('sha256', this.config.clientSecret)
        .update(`${timestamp}.${body}`)
        .digest('base64');

      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new PaymentGatewayError('INVALID_SIGNATURE', 'Webhook signature did not match', 401);
      }
      return JSON.parse(body) as WebhookEvent;
    },
  };

  /* ------------------------------------------------------------ paging */

  private listOrders(options: ListOrdersOptions = {}): Promise<Page<Order>> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor) query.set('cursor', options.cursor);
    const qs = query.toString();
    return this.request<Page<Order>>('GET', `/pg/orders${qs ? '?' + qs : ''}`);
  }

  private async *eachOrder(options: { limit?: number } = {}): AsyncGenerator<Order> {
    let cursor: string | undefined;
    do {
      const page: Page<Order> = await this.listOrders({ limit: options.limit, cursor });
      yield* page.data;
      cursor = page.nextCursor;
    } while (cursor);
  }

  /* ------------------------------------------------------------ transport */

  /**
   * Send one request, retrying the failures that are worth retrying.
   *
   * What gets retried: network errors, timeouts, 429, and 5xx. Those are the
   * gateway's problem, not the caller's, and are usually gone a moment later.
   *
   * What never gets retried: any other 4xx. A declined card or a bad amount will
   * be declined and bad again, and hammering it only adds load.
   *
   * Writes are only retried when they carry an idempotency key, because without
   * one a retry could create a second order. The gateway dedupes on that key, so
   * the retry returns the original order instead of charging twice.
   */
  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const safeToRetry = method === 'GET' || Boolean(idempotencyKey);
    const attempts = safeToRetry ? this.maxRetries + 1 : 1;

    let lastError: PaymentGatewayError | undefined;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt, this.retryBaseMs));

      try {
        return await this.send<T>(method, path, body, idempotencyKey);
      } catch (err) {
        const e = err as PaymentGatewayError;
        lastError = e;
        if (!isRetryable(e) || attempt === attempts - 1) throw e;
      }
    }

    // Unreachable — the loop either returns or throws.
    throw lastError;
  }

  private async send<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': this.config.clientId,
          'x-client-secret': this.config.clientSecret,
          'x-api-version': '2026-01-01',
          'user-agent': 'payment-gateway-node-sdk-node/1.0.0',
          ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // The request never completed, so the outcome is UNKNOWN — not failed.
      // Re-fetch the order before assuming anything.
      const aborted = (err as Error)?.name === 'AbortError';
      throw new PaymentGatewayError(
        aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
        aborted ? `Request timed out after ${this.timeout}ms` : 'Could not reach the gateway',
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const json = text ? safeParse(text) : {};

    if (!res.ok) {
      throw new PaymentGatewayError(
        json?.code ?? 'API_ERROR',
        json?.message ?? `The gateway returned ${res.status}`,
        res.status,
        res.headers.get('x-request-id') ?? undefined,
      );
    }
    return json as T;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, so a fleet of servers does not retry in lockstep. */
function backoffMs(attempt: number, baseMs: number): number {
  const exponential = baseMs * 2 ** (attempt - 1);
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

function isRetryable(err: PaymentGatewayError): boolean {
  if (err.statusCode === 0) return true;           // never reached the gateway
  if (err.statusCode === 429) return true;         // rate limited
  return err.statusCode >= 500 && err.statusCode < 600;
}

function safeParse(text: string): any {
  try { return JSON.parse(text); } catch { return { message: text }; }
}

export default PaymentGateway;
