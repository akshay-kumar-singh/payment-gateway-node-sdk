# paywize-dummy-pg

The Paywize server SDK for Node.js. Node 18+, ESM and CommonJS, TypeScript types included.

```bash
npm install paywize-dummy-pg
```

## Usage

```js
import { Paywize } from 'paywize-dummy-pg';

const paywize = new Paywize({
  clientId: process.env.PAYWIZE_CLIENT_ID,
  clientSecret: process.env.PAYWIZE_CLIENT_SECRET,   // server only. never a browser.
  environment: 'sandbox',
});

const order = await paywize.orders.create({
  orderAmount: 499,
  customerDetails: { customerId: 'c1', customerPhone: '9999999999' },
});

// send order.paymentSessionId to the browser
```

### Confirm before you ship

```js
const order = await paywize.orders.fetch(orderId);
if (order.orderStatus === 'PAID') { /* safe */ }
```

### Webhooks

```js
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const event = paywize.webhooks.verify(
    req.body,                               // RAW bytes, not parsed JSON
    req.header('x-webhook-signature'),
    req.header('x-webhook-timestamp'),
  );                                        // throws on a bad signature
  res.sendStatus(200);
});
```

Full docs: https://docs.paywize.in/sdk/node

MIT
