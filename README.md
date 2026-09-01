# payment-gateway-node-sdk

The payment gateway server SDK for Node.js. Node 18+, ESM and CommonJS, TypeScript types included.

```bash
npm install payment-gateway-node-sdk
```

## Usage

```js
import { PaymentGateway } from 'payment-gateway-node-sdk';

const gateway = new PaymentGateway({
  clientId: process.env.PG_CLIENT_ID,
  clientSecret: process.env.PG_CLIENT_SECRET,   // server only. never a browser.
  environment: 'sandbox',
});

const order = await gateway.orders.create({
  orderAmount: 499,
  customerDetails: { customerId: 'c1', customerPhone: '9999999999' },
});

// send order.paymentSessionId to the browser
```

### Confirm before you ship

```js
const order = await gateway.orders.fetch(orderId);
if (order.orderStatus === 'PAID') { /* safe */ }
```

### Webhooks

```js
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const event = gateway.webhooks.verify(
    req.body,                               // RAW bytes, not parsed JSON
    req.header('x-webhook-signature'),
    req.header('x-webhook-timestamp'),
  );                                        // throws on a bad signature
  res.sendStatus(200);
});
```

Full docs: https://payment-gateway-docs.netlify.app/sdk/node

MIT
