# OriPostales

Handwritten postcard service. Customers upload a photo, write a message, and pay. You get an email with everything you need to print on your Instax and mail the postcard by hand.

## Stack

- **Frontend** — static HTML/CSS/JS, hosted on GitHub Pages
- **Backend** — Node.js + Express, running on Hetzner VPS under PM2
- **Payments** — Stripe Checkout (hosted, no card data on our server)
- **Email** — [Resend](https://resend.com) (transactional email API)
- **Storage** — `orders.json` + `uploads/` on disk

---

## Local development

```bash
cd backend
cp .env.example .env
# fill in .env (see below)
npm install
npm run dev
```

Open `frontend/index.html` directly in a browser (or serve with `npx serve frontend`).

---

## Environment variables

Copy `backend/.env.example` to `backend/.env` and fill in:

| Variable | Description |
|---|---|
| `STRIPE_SECRET_KEY` | From [Stripe dashboard](https://dashboard.stripe.com/apikeys) |
| `STRIPE_WEBHOOK_SECRET` | From Stripe → Webhooks → your endpoint |
| `STRIPE_PRICE_CENTS` | Price in cents, e.g. `1500` for €15 |
| `STRIPE_CURRENCY` | ISO currency code, e.g. `eur` |
| `RESEND_API_KEY` | From [resend.com/api-keys](https://resend.com/api-keys) |
| `RESEND_FROM` | Verified sender, e.g. `OriPostales <postales@psiesta.com>` |
| `EMAIL_TO` | Where order notifications are sent (your inbox) |
| `PORT` | Default `3001` |
| `FRONTEND_URL` | e.g. `https://psiesta.com/postal` |
| `UPLOADS_BASE_URL` | e.g. `https://api.psiesta.com/uploads` |

### Setting up Resend

1. Sign up at [resend.com](https://resend.com) — free tier is 3,000 emails/month
2. Add and verify your sending domain (DNS TXT record)
3. Create an API key → paste into `RESEND_API_KEY`
4. Set `RESEND_FROM` to an address on your verified domain

> **Testing without a domain:** use `onboarding@resend.dev` as `RESEND_FROM` while developing — no domain verification needed.

---

## Production deployment

### 1. Start the backend with PM2

```bash
cd /home/psiesta11/repositories/oripostales/backend
pm2 start server.js --name oripostales-api
pm2 save
```

Check it's running:
```bash
pm2 list
curl http://localhost:3001/api/health
```

### 2. Nginx

The config lives in `nginx/oripostales-api.conf`. Deploy it:

```bash
sudo cp nginx/oripostales-api.conf /etc/nginx/sites-available/oripostales-api
sudo ln -sf /etc/nginx/sites-available/oripostales-api /etc/nginx/sites-enabled/oripostales-api
sudo nginx -t && sudo systemctl reload nginx
```

This adds `api.psiesta.com` → `localhost:3001`. It does **not** touch the CoraTravel config.

### 3. Stripe webhook

In the [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks):
- Endpoint URL: `https://api.psiesta.com/api/webhook`
- Event: `checkout.session.completed`
- Copy the signing secret → `STRIPE_WEBHOOK_SECRET` in `.env`
- Restart PM2 after updating `.env`: `pm2 restart oripostales-api`

### 4. Frontend (GitHub Pages)

Push this repo to GitHub. Enable Pages from the `frontend/` folder (Settings → Pages → Source: `frontend/`).

Point `psiesta.com/postal` DNS to GitHub Pages.

---

## Verification checklist

- [ ] `curl https://api.psiesta.com/api/health` returns `{"status":"OK",...}`
- [ ] Submit form with test photo → `orders.json` has a `pending_payment` entry
- [ ] Complete Stripe test payment → order status changes to `paid`
- [ ] Email received with recipient address, message, and photo link
- [ ] `uploads/` contains the photo file
- [ ] `success.html` loads after Stripe redirect
- [ ] Form is usable on mobile

---

## PM2 cheatsheet

```bash
pm2 list                          # status of all apps
pm2 logs oripostales-api          # live logs
pm2 restart oripostales-api       # restart after .env changes
pm2 stop oripostales-api          # stop
```
