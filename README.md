# Jimmy Grills Email Agent

AI-powered email sales agent. Reads inbound customer emails via webhooks, uses Claude to write upsell/nurture replies, sends drafts to Telegram for approval, and sends via Amazon SES.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Run locally

```bash
npm run dev    # with auto-restart on file changes
npm start      # production
```

## Deployment (DigitalOcean)

### Provision a droplet

- Ubuntu 24.04, $6/mo Basic
- Add your SSH key

### Server setup

```bash
ssh root@YOUR_IP

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install PM2
npm install -g pm2

# Install build tools for better-sqlite3
apt-get install -y build-essential python3

# Clone your repo
git clone YOUR_REPO_URL /opt/email-agent
cd /opt/email-agent
npm install --production

# Configure environment
cp .env.example .env
nano .env  # fill in values

# Start with PM2
pm2 start src/server.js --name email-agent
pm2 save
pm2 startup  # follow the printed command to enable on boot
```

### Nginx + SSL (optional)

```bash
apt-get install -y nginx certbot python3-certbot-nginx

cat > /etc/nginx/sites-available/email-agent << 'EOF'
server {
    listen 80;
    server_name YOUR_DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

ln -s /etc/nginx/sites-available/email-agent /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# SSL
certbot --nginx -d YOUR_DOMAIN
```

### FunnelKit webhook setup

Point these webhooks to your server:

- Inbound email: `POST https://YOUR_DOMAIN/webhook/inbound-email?secret=YOUR_WEBHOOK_SECRET`
- Contact events: `POST https://YOUR_DOMAIN/webhook/contact-event?secret=YOUR_WEBHOOK_SECRET`

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Bot status, pending approvals, auto-approve state |
| `/auto on` | Enable auto-approve (emails send without approval) |
| `/auto off` | Disable auto-approve (default) |
| `/blacklist email` | Block a contact from automated emails |
| `/unblacklist email` | Unblock a contact |
| `/outreach` | Manually trigger proactive outreach |
| `/sync` | Manually trigger CRM contact sync |
| `/pending` | Resend all pending approval messages |

## Architecture

```
FunnelKit webhook → Express server → Claude (draft) → Telegram (approve) → SES (send)
                                                    → Auto-send if enabled
Cron (daily)      → CRM sync + outreach → same flow
```

## Editing Products & Upsell Rules

Edit `src/config.js` to:
- Add/remove products
- Change upsell rule priorities
- Update product aliases for WooCommerce mapping
- Modify the nurture fallback message
