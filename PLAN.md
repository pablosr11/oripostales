# Plan: OriPostales — Handwritten Postcard Service

## Context
Build a simple, warm service at psiesta.com/postal where anyone can upload a photo, write a personal message, and provide a recipient address. They pay a fixed price via Stripe. You receive an email with everything you need to handwrite the message, print with your Instax, and mail the physical postcard.

## Architecture

```
psiesta.com/postal  (GitHub Pages — static HTML/CSS/JS)
        │
        │  POST multipart/form-data (photo + order fields)
        ▼
api.psiesta.com  (or psiesta.com/postal-api — Nginx on Hetzner VPS)
        │
        ├── Node.js + Express (PM2, new app: oripostales-api)
        │     ├── /api/orders      → save order + create Stripe Checkout session
        │     └── /api/webhook     → Stripe confirms payment → mark paid + send email
        │
        ├── orders.json            → append-only order log
        ├── uploads/               → customer photos saved to disk
        └── Nodemailer             → email you with full order on payment
```

## Tech Stack
- **Frontend**: Vanilla HTML + CSS + JS — no framework, single `index.html`
- **Backend**: Node.js + Express (JS, not TS — keep it simple, no build step)
- **Payments**: Stripe Checkout (hosted page — no PCI scope on our server)
- **Storage**: `orders.json` file + local `uploads/` directory on VPS
- **Email**: Nodemailer via Gmail SMTP (or any SMTP)
- **Process**: PM2 (same as CoraTravel)
- **Proxy**: Nginx reverse proxy on existing VPS

## Repository Structure
```
/home/psiesta11/repositories/oripostales/
├── frontend/
│   ├── index.html       ← single page form (upload, message, address, pay)
│   ├── success.html     ← "thank you" page shown after Stripe payment
│   └── style.css        ← warm, handcrafted aesthetic
└── backend/
    ├── server.js        ← Express app
    ├── package.json
    ├── .env             ← STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, EMAIL creds, PRICE
    ├── orders.json      ← auto-created, append-only order log
    └── uploads/         ← customer photos
```

## User Flow
1. User visits `psiesta.com/postal`
2. Fills in: their name + email, recipient name + full address, personal message, photo upload
3. Clicks "Send this postcard" — JS sends multipart POST to VPS API
4. API saves photo to `uploads/`, writes pending order to `orders.json`, creates Stripe Checkout session
5. Frontend redirects user to Stripe Checkout (hosted, no card data on our server)
6. User pays €15 (placeholder — configurable via `PRICE` env var)
7. Stripe calls `/api/webhook` on VPS
8. Webhook updates order status to `paid` in `orders.json`
9. Nodemailer sends you an email: sender info, recipient address, message, link to the uploaded photo
10. User lands on `success.html` — warm thank-you message

## Critical Files to Create

### `frontend/index.html`
- Single form: sender name/email, recipient name/address, message textarea (max ~150 chars shown), photo file input
- On submit: fetch POST to VPS API, then redirect to Stripe URL returned
- Aesthetic: off-white background, warm serif font (e.g. Georgia or a Google Font like Lora), subtle paper texture via CSS

### `frontend/success.html`
- Simple thank-you page. No dynamic content needed.

### `backend/server.js`
Key logic:
```
POST /api/orders
  - multer handles photo upload → saves to uploads/{uuid}.jpg
  - validates fields (name, email, recipient address, message)
  - appends order to orders.json with status: "pending_payment"
  - creates stripe.checkout.sessions.create({ mode: "payment", ... })
  - returns { checkoutUrl }

POST /api/webhook
  - stripe.webhooks.constructEvent() verifies signature
  - on checkout.session.completed: update orders.json entry to status: "paid"
  - send email via nodemailer with all order details + photo path/URL
```

### `backend/.env`
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_USD=1500          # in cents
EMAIL_FROM=you@gmail.com
EMAIL_TO=you@gmail.com
EMAIL_PASS=gmail_app_password
PORT=3001
FRONTEND_URL=https://psiesta.com/postal
UPLOADS_BASE_URL=https://api.psiesta.com/uploads
```

## Nginx Configuration (additions to existing nginx on VPS)
Add a new server block (or location block) to expose:
- `api.psiesta.com` → proxy to `localhost:3001`
- `api.psiesta.com/uploads/` → serve static files from uploads dir

## PM2 Setup
```bash
cd /home/psiesta11/repositories/oripostales/backend
pm2 start server.js --name oripostales-api
pm2 save
```

## Deployment
1. Push `frontend/` to GitHub → enable GitHub Pages from `frontend/` folder
2. In Cloudflare (or wherever psiesta.com DNS lives): set `psiesta.com/postal` → GitHub Pages, and `api.psiesta.com` → Hetzner VPS IP
3. Start backend on VPS with PM2
4. Configure Stripe webhook endpoint to `https://api.psiesta.com/api/webhook`

## Dependencies (backend)
```json
"express", "multer", "stripe", "nodemailer", "uuid", "dotenv", "cors"
```

## Nginx Safety — Do NOT Break Existing Sites
The VPS already runs CoraTravel (and possibly others) under Nginx. All changes must be additive only:
- Add a **new `server` block** for `api.psiesta.com` in a new file `/etc/nginx/sites-available/oripostales-api`
- Never touch the existing CoraTravel nginx config (`coratravels.com` server block)
- Test config before reloading: `sudo nginx -t && sudo systemctl reload nginx`
- If anything breaks, rollback by removing the new sites-available file and reloading

## Future Domain Migration (psiesta.com/postal → oripostales.com or similar)
When you're ready to move to a standalone domain, here's what changes:

| What | Now | Later |
|------|-----|-------|
| Frontend URL | `psiesta.com/postal` (GitHub Pages) | `oripostales.com` (same GitHub Pages, new CNAME) |
| API URL | `api.psiesta.com` | `api.oripostales.com` |
| DNS | Cloudflare psiesta.com records | New domain DNS → same Hetzner VPS IP |
| Nginx | Add new server block for new domain | Same config, new `server_name` |
| Stripe | Update webhook URL in dashboard | Point to new API domain |
| Frontend `.env` / config | Update `API_BASE_URL` constant in `index.html` | Point to new domain |
| GitHub Pages | Add new CNAME file in repo | Point to new domain |

**Steps to migrate:**
1. Buy new domain, point DNS A record → Hetzner VPS IP
2. Add `server_name oripostales.com;` block in Nginx (copy from `api.psiesta.com` block)
3. Update `API_BASE_URL` in `frontend/index.html` → new domain
4. Update `FRONTEND_URL` and `UPLOADS_BASE_URL` in backend `.env`
5. Update Stripe webhook endpoint in Stripe dashboard
6. Update GitHub Pages custom domain (CNAME file)
7. Keep old `psiesta.com/postal` redirecting to new domain for ~3 months

## Verification
1. Submit the form with a test photo → check `orders.json` for pending entry
2. Use Stripe test mode → complete payment → verify order status changes to `paid`
3. Confirm email received with recipient address, message, photo link
4. Check `uploads/` directory has the photo file
5. Verify `success.html` loads after Stripe redirect
6. Test on mobile (form must be usable on phone)
