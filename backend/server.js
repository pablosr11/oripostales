'use strict';

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const fs         = require('fs');

// ── Config ───────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT || 3001;
const FRONTEND_URL     = process.env.FRONTEND_URL || 'http://localhost:8080';
const UPLOADS_BASE_URL = process.env.UPLOADS_BASE_URL || `http://localhost:${PORT}/uploads`;
const PRICE_CENTS      = parseInt(process.env.STRIPE_PRICE_CENTS || '1500', 10);
const CURRENCY         = process.env.STRIPE_CURRENCY || 'eur';

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const ORDERS_FILE = path.join(__dirname, 'orders.json');

// Ensure directories/files exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');

// ── Resend email client (lazy — initialized on first send) ───────────────────

// ── Multer (file upload) ─────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

// ── Order helpers ────────────────────────────────────────────────────────────

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

function appendOrder(order) {
  const orders = readOrders();
  orders.push(order);
  writeOrders(orders);
}

function updateOrderStatus(orderId, status) {
  const orders = readOrders();
  const idx = orders.findIndex(o => o.id === orderId);
  if (idx !== -1) {
    orders[idx].status = status;
    orders[idx].updatedAt = new Date().toISOString();
    writeOrders(orders);
    return orders[idx];
  }
  return null;
}

function findOrderBySessionId(sessionId) {
  return readOrders().find(o => o.stripeSessionId === sessionId) || null;
}

// ── Email ────────────────────────────────────────────────────────────────────

async function sendOrderEmail(order) {
  const photoUrl = `${UPLOADS_BASE_URL}/${order.photoFilename}`;
  const subject  = `📬 New postcard order — ${order.senderName} → ${order.recipientName}`;

  const html = `
    <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; color: #2c1a0e;">
      <h2 style="color: #8b5e3c;">New postcard order received!</h2>
      <p><strong>Order ID:</strong> ${order.id}</p>
      <p><strong>Paid at:</strong> ${new Date().toLocaleString()}</p>
      <hr style="border-color: #d4c4b0;">

      <h3 style="color: #8b5e3c;">From (sender)</h3>
      <p><strong>Name:</strong> ${order.senderName}</p>
      <p><strong>Email:</strong> ${order.senderEmail}</p>

      <h3 style="color: #8b5e3c;">To (recipient)</h3>
      <p><strong>Name:</strong> ${order.recipientName}</p>
      <p><strong>Address:</strong></p>
      <pre style="background:#f4ede2;padding:0.75rem;border-radius:4px;">${order.recipientAddress}</pre>

      <h3 style="color: #8b5e3c;">Message to write</h3>
      <blockquote style="background:#f4ede2;border-left:3px solid #c0724a;padding:0.75rem 1rem;margin:0;border-radius:0 4px 4px 0;">
        ${order.message}
      </blockquote>

      <h3 style="color: #8b5e3c;">Photo</h3>
      <p><a href="${photoUrl}">${photoUrl}</a></p>
      <img src="${photoUrl}" alt="Customer photo" style="max-width:300px;border-radius:4px;border:1px solid #d4c4b0;">
    </div>
  `;

  const { error } = await getResend().emails.send({
    from:    process.env.RESEND_FROM,
    to:      process.env.EMAIL_TO,
    subject,
    html,
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
}

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();

// CORS — allow the GitHub Pages frontend
app.use(cors({
  origin: [
    FRONTEND_URL,
    /^https?:\/\/localhost/,
    /^https?:\/\/(www\.)?psiesta\.com/,
    /^https?:\/\/[a-z0-9-]+\.github\.io/,
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// Serve uploaded photos (static)
app.use('/uploads', express.static(UPLOADS_DIR));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'OriPostales API is running' });
});

// ── POST /api/orders ─────────────────────────────────────────────────────────

app.post('/api/orders', upload.single('photo'), async (req, res) => {
  try {
    const { senderName, senderEmail, recipientName, recipientAddress, message } = req.body;

    // Validate
    if (!senderName || !senderEmail || !recipientName || !recipientAddress || !message) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A photo is required.' });
    }

    const orderId = uuidv4();
    const now     = new Date().toISOString();

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: CURRENCY,
          unit_amount: PRICE_CENTS,
          product_data: {
            name: 'Handwritten Postcard',
            description: `From ${senderName} to ${recipientName}`,
            images: [],
          },
        },
        quantity: 1,
      }],
      customer_email: senderEmail,
      success_url: `${FRONTEND_URL}/success.html?order=${orderId}`,
      cancel_url:  `${FRONTEND_URL}/index.html`,
      metadata: { orderId },
    });

    // Save order to disk
    const order = {
      id:               orderId,
      stripeSessionId:  session.id,
      status:           'pending_payment',
      createdAt:        now,
      updatedAt:        now,
      senderName,
      senderEmail,
      recipientName,
      recipientAddress,
      message,
      photoFilename:    req.file.filename,
    };
    appendOrder(order);

    res.json({ checkoutUrl: session.url });

  } catch (err) {
    console.error('POST /api/orders error:', err);
    // Clean up uploaded file if something went wrong after upload
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
    res.status(500).json({ error: 'Could not create order. Please try again.' });
  }
});

// ── POST /api/webhook ────────────────────────────────────────────────────────
// Must use raw body — express.json() must NOT have run before this route.

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;

    if (!orderId) {
      console.warn('Webhook: checkout.session.completed with no orderId in metadata');
      return res.json({ received: true });
    }

    const order = updateOrderStatus(orderId, 'paid');
    if (!order) {
      console.warn(`Webhook: order ${orderId} not found in orders.json`);
      return res.json({ received: true });
    }

    console.log(`Order ${orderId} marked as paid. Sending email...`);
    try {
      await sendOrderEmail(order);
      console.log(`Email sent for order ${orderId}`);
    } catch (emailErr) {
      // Don't fail the webhook — Stripe will retry if we return non-2xx
      console.error(`Failed to send email for order ${orderId}:`, emailErr);
    }
  }

  res.json({ received: true });
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`OriPostales API listening on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/api/health`);
  console.log(`  Uploads dir: ${UPLOADS_DIR}`);
  console.log(`  Orders file: ${ORDERS_FILE}`);
});
