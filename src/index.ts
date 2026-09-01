/**
 * paywize-pg — the Paywize server SDK for Node.
 *
 * This runs on YOUR server and holds your secret key. It must never be imported into
 * browser code: the secret can create charges and issue refunds.
 *
 *   const paywize = new Paywize({ clientId, clientSecret, environment: 'sandbox' });
 *   const order = await paywize.orders.create({ ... });
 *   // send order.paymentSessionId to the browser
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  PaywizeError,
  type CreateOrderRequest, type Environment, type Order,
  type Payment, type Refund, type WebhookEvent,
} from './types.js';

export * from './types.js';

const HOSTS: Record<Environment, string> = {
  sandbox: 'https://sandbox-api.paywize.in',
  production: 'https://api.paywize.in',
};

export interface PaywizeConfig {
  clientId: string;
  clientSecret: string;
  environment?: Environment;
  /** Point at a locally running gateway while developing. */
  baseUrl?: string;
  /** Milliseconds. Default 30s. */
  timeout?: number;
}

export class Paywize {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(private readonly config: PaywizeConfig) {
    if (!config?.clientId || !config?.clientSecret) {
      throw new Error('paywize-dummy-pg: clientId and clientSecret are required');
    }
    const env = config.environment ?? 'sandbox';
    this.baseUrl = (config.baseUrl ?? HOSTS[env]).replace(/\/$/, '');
    this.timeout = config.timeout ?? 30_000;
  }

  /* --------------------------------------------------------------- orders */

  orders = {
    create: async (req: CreateOrderRequest): Promise<Order> => {
      if (!(req.orderAmount > 0)) throw new Error('paywize-dummy-pg: orderAmount must be greater than 0');
      if (!req.customerDetails?.customerPhone) {
        throw new Error('paywize-dummy-pg: customerDetails.customerPhone is required');
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
        throw new PaywizeError('INVALID_SIGNATURE', 'Missing signature or timestamp header', 400);
      }
      // Replay guard: the timestamp is inside the signed payload, so an attacker
      // cannot resend yesterday's "payment succeeded" with a fresh clock.
      const ageMs = Math.abs(Date.now() - Number(timestamp) * 1000);
      if (!Number.isFinite(ageMs) || ageMs > 5 * 60_000) {
        throw new PaywizeError('SIGNATURE_EXPIRED', 'Webhook timestamp is outside the 5 minute window', 400);
      }

      const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      const expected = createHmac('sha256', this.config.clientSecret)
        .update(`${timestamp}.${body}`)
        .digest('base64');

      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new PaywizeError('INVALID_SIGNATURE', 'Webhook signature did not match', 401);
      }
      return JSON.parse(body) as WebhookEvent;
    },
  };

  /* ------------------------------------------------------------ transport */

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
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
          'user-agent': 'paywize-dummy-pg-node/1.0.0',
          ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // The request never completed, so the outcome is UNKNOWN — not failed.
      // Re-fetch the order before assuming anything.
      const aborted = (err as Error)?.name === 'AbortError';
      throw new PaywizeError(
        aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
        aborted ? `Request timed out after ${this.timeout}ms` : 'Could not reach Paywize',
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const json = text ? safeParse(text) : {};

    if (!res.ok) {
      throw new PaywizeError(
        json?.code ?? 'API_ERROR',
        json?.message ?? `Paywize returned ${res.status}`,
        res.status,
        res.headers.get('x-request-id') ?? undefined,
      );
    }
    return json as T;
  }
}

function safeParse(text: string): any {
  try { return JSON.parse(text); } catch { return { message: text }; }
}

export default Paywize;
