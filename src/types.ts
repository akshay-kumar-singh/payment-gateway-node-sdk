export type Environment = 'sandbox' | 'production';

export interface CustomerDetails {
  customerId: string;
  customerPhone: string;
  customerEmail?: string;
  customerName?: string;
}

export interface CreateOrderRequest {
  /** In rupees, e.g. 499.50. The SDK converts to paise for the wire. */
  orderAmount: number;
  orderCurrency?: 'INR';
  customerDetails: CustomerDetails;
  /** Your own reference. Reused as the idempotency key, so a retry is safe. */
  orderId?: string;
  /** Where the customer lands after a redirect checkout. */
  returnUrl?: string;
  /** Free-form; comes back on every webhook and fetch. */
  orderNote?: string;
  orderTags?: Record<string, string>;
}

export type OrderStatus = 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED';

export interface Order {
  orderId: string;
  orderStatus: OrderStatus;
  orderAmount: number;
  orderCurrency: string;
  /** Hand this to paywize-js in the browser. Nothing else crosses to the client. */
  paymentSessionId: string;
  customerDetails: CustomerDetails;
  orderNote?: string;
  orderTags?: Record<string, string>;
  createdAt: string;
  orderExpiryTime: string;
}

export type PaymentStatus = 'SUCCESS' | 'FAILED' | 'PENDING' | 'USER_DROPPED';

export interface Payment {
  paymentId: string;
  orderId: string;
  paymentStatus: PaymentStatus;
  paymentAmount: number;
  paymentCurrency: string;
  paymentMethod: string;
  paymentMessage: string;
  bankReference?: string;
  paymentTime?: string;
  errorCode?: string;
}

export interface Refund {
  refundId: string;
  orderId: string;
  paymentId: string;
  refundAmount: number;
  refundStatus: 'PENDING' | 'SUCCESS' | 'FAILED';
  refundNote?: string;
  createdAt: string;
}

export interface WebhookEvent {
  type: string;
  eventTime: string;
  data: { order?: Order; payment?: Payment; refund?: Refund };
}

/** Thrown for any non-2xx. Inspect `code` — never parse `message`. */
export class PaywizeError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'PaywizeError';
  }
}
