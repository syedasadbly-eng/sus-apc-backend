# Smart Urban Sensing — APC Backend Server

24/7 data persistence backend for the APC Dashboard. Subscribes to your MQTT broker, stores every passenger counting event in SQLite, and serves historical data via REST API.

## Architecture

```
VS125 Sensor → UR35 Gateway → HiveMQ Cloud (MQTT) → THIS BACKEND → SQLite
                                    ↓                      ↓
                              Dashboard (browser)     REST API → Dashboard
                              (live via WebSocket)    (historical data)
```

The backend and the dashboard frontend connect to the **same MQTT broker** independently:
- **Backend** connects via `mqtts://` on port **8883** (TLS) — persists data to SQLite
- **Dashboard** connects via `wss://` on port **8884** (WebSocket) — displays live data
- The dashboard calls the backend REST API for historical charts, comparisons, and exports

---

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

The server will:
- Start on `http://localhost:3001`
- Connect to your HiveMQ Cloud MQTT broker
- Create `apc_data.db` SQLite database automatically
- Begin storing all VS125/UR35 telemetry data

Verify it's working:
```bash
curl http://localhost:3001/api/health
```

Expected response:
```json
{
  "status": "ok",
  "mqtt": "connected",
  "mqttMessages": 42,
  "dbRecords": 156,
  "uptime": 300
}
```

---

## MQTT Broker Credentials

These are pre-configured as defaults in `server.js`. Override with environment variables if needed.

| Setting       | Value                                                          |
|---------------|----------------------------------------------------------------|
| **Host**      | `492260d5d94c4b4e87ade94ae81925e6.s1.eu.hivemq.cloud`         |
| **TLS Port**  | `8883` (backend uses this — MQTT over TLS)                     |
| **WS Port**   | `8884` (dashboard uses this — MQTT over WebSocket/TLS)         |
| **Username**  | `sus-dashboard`                                                |
| **Password**  | `SuS-Mqtt#2026!Secure`                                        |
| **Topic**     | `bus/#` (subscribes to all bus telemetry)                      |

### Device Data Path

```
VS125 (SN: 6537F28525760003)
    → publishes passenger counts to UR35 via serial
UR35 Gateway (Client ID: bus-001-ur35)
    → publishes JSON to topic: bus/001/telemetry
    → publishes GPS to topic: bus/001/telemetry
Backend
    → subscribes to bus/# on port 8883
    → stores everything in SQLite
```

### VS125 Message Types

The VS125 sends three types of counting data in JSON payloads:

| Message Type          | JSON Path                              | Description                    |
|-----------------------|----------------------------------------|--------------------------------|
| `line_total_data`     | `line_total_data.0.total.in_counted`   | Running daily totals (best)    |
| `line_periodic_data`  | `line_periodic_data.0.total.in`        | Per-minute summary             |
| `line_trigger_data`   | `line_trigger_data.0.total.in`         | Individual door events (0/1)   |

---

## Environment Variables

All configuration can be overridden with environment variables:

| Variable       | Default                                                  | Description                |
|----------------|----------------------------------------------------------|----------------------------|
| `PORT`         | `3001`                                                   | HTTP server port           |
| `DB_PATH`      | `./apc_data.db`                                          | SQLite database file path  |
| `MQTT_HOST`    | `492260d5d94c4b4e87ade94ae81925e6.s1.eu.hivemq.cloud`   | MQTT broker hostname       |
| `MQTT_PORT`    | `8883`                                                   | MQTT TLS port              |
| `MQTT_USER`    | `sus-dashboard`                                          | MQTT username              |
| `MQTT_PASS`    | `SuS-Mqtt#2026!Secure`                                   | MQTT password              |
| `MQTT_TOPIC`   | `bus/#`                                                  | MQTT subscription topic    |
| `BUS_CAPACITY` | `55`                                                     | Bus capacity for occupancy |
| `DB_VERBOSE`   | _(unset)_                                                | Set to `1` for SQL logging |

---

## SQLite Database Schema

The database is created automatically on first run. Three tables:

### `records` — Raw Data (every MQTT counting message)

| Column       | Type    | Description                                |
|--------------|---------|--------------------------------------------|
| `id`         | INTEGER | Auto-increment primary key                 |
| `timestamp`  | TEXT    | ISO 8601 UTC (e.g. `2026-03-09T20:15:30Z`) |
| `date`       | TEXT    | `YYYY-MM-DD` for fast date queries         |
| `hour`       | INTEGER | 0–23 UTC hour                              |
| `bus_id`     | TEXT    | Bus identifier (e.g. `SUS-001`)            |
| `route`      | TEXT    | Route ID                                   |
| `stop`       | TEXT    | Stop name (currently `-`)                  |
| `boardings`  | INTEGER | Cumulative boardings (daily running total) |
| `alightings` | INTEGER | Cumulative alightings (daily running total)|
| `evt_in`     | INTEGER | Per-event boarding count                   |
| `evt_out`    | INTEGER | Per-event alighting count                  |
| `onboard`    | INTEGER | Current passengers on board                |
| `occupancy`  | REAL    | Occupancy percentage (0–100)               |
| `lat`        | REAL    | GPS latitude                               |
| `lng`        | REAL    | GPS longitude                              |
| `speed`      | REAL    | Speed in km/h                              |
| `msg_type`   | TEXT    | `daily_total`, `periodic`, `trigger`, `legacy` |

### `hourly_summary` — Hourly Aggregation

| Column        | Type    | Description                         |
|---------------|---------|-------------------------------------|
| `date`        | TEXT    | `YYYY-MM-DD`                        |
| `hour`        | INTEGER | 0–23                                |
| `bus_id`      | TEXT    | Bus identifier                      |
| `boardings`   | INTEGER | Total boardings this hour           |
| `alightings`  | INTEGER | Total alightings this hour          |
| `max_onboard` | INTEGER | Peak passengers onboard this hour   |
| `msg_count`   | INTEGER | Number of MQTT messages this hour   |

**Unique constraint:** `(date, hour, bus_id)`

### `daily_summary` — Daily Totals

| Column         | Type    | Description                       |
|----------------|---------|-----------------------------------|
| `date`         | TEXT    | `YYYY-MM-DD`                      |
| `bus_id`       | TEXT    | Bus identifier                    |
| `total_in`     | INTEGER | Total boardings for the day       |
| `total_out`    | INTEGER | Total alightings for the day      |
| `peak_onboard` | INTEGER | Maximum passengers at once        |
| `peak_hour`    | INTEGER | Hour with peak onboard            |
| `first_seen`   | TEXT    | First message timestamp           |
| `last_seen`    | TEXT    | Last message timestamp            |
| `avg_occupancy`| REAL    | Average occupancy percentage      |

**Unique constraint:** `(date, bus_id)`

### Indexes

```sql
idx_records_date        ON records(date)
idx_records_bus_date    ON records(bus_id, date)
idx_records_timestamp   ON records(timestamp)
idx_hourly_date         ON hourly_summary(date)
idx_daily_date          ON daily_summary(date)
```

---

## REST API Endpoints

All endpoints return JSON. Base URL: `http://your-server:3001`

### `GET /api/health` — Health Check

```
GET /api/health
```

Returns server status, MQTT connection, record count, uptime.

### `GET /api/live` — Live Bus State

```
GET /api/live
```

Returns current in-memory state of all buses (from MQTT), including GPS, passenger counts, and status.

### `GET /api/records` — Raw Records (Data Explorer)

```
GET /api/records?date=2026-03-09&bus_id=SUS-001&limit=50&offset=0
```

| Param    | Required | Description                    |
|----------|----------|--------------------------------|
| `date`   | No       | Filter by date (YYYY-MM-DD)    |
| `bus_id` | No       | Filter by bus ID               |
| `limit`  | No       | Records per page (default 500) |
| `offset` | No       | Pagination offset (default 0)  |

Returns: `{ total: number, records: [...] }`

### `GET /api/hourly` — Hourly Summary

```
GET /api/hourly?date=2026-03-09&bus_id=SUS-001
```

Returns hourly aggregated data for charts and heatmaps.

### `GET /api/daily` — Daily Summary

```
GET /api/daily?from=2026-03-01&to=2026-03-09&bus_id=SUS-001
```

| Param    | Required | Description          |
|----------|----------|----------------------|
| `from`   | No       | Start date           |
| `to`     | No       | End date             |
| `bus_id` | No       | Filter by bus ID     |

Returns: `{ daily: [...] }`

### `GET /api/summary` — Aggregated KPIs

```
GET /api/summary?period=2026-03-01
```

`period` can be: `today`, `week`, `month`, `year`, or a raw `YYYY-MM-DD` date (used as "from" date).

Returns totals, peak hour, and daily breakdown.

### `GET /api/compare` — Compare Two Dates

```
GET /api/compare?date_a=2026-03-08&date_b=2026-03-09
```

Returns boardings/alightings totals and hourly breakdown for both dates.

### `GET /api/dates` — Available Dates

```
GET /api/dates
```

Returns array of dates that have data (most recent first, up to 365).

### `GET /api/buses` — Available Bus IDs

```
GET /api/buses
```

Returns array of bus IDs that have recorded data.

---

## Deployment

### Option A: Railway (Recommended — Easiest)

[Railway](https://railway.app) provides free SSL, auto-deploys from GitHub, and persistent volumes for SQLite.

#### Step 1: Push to GitHub

```bash
# Create a new GitHub repo, then:
cd sus-backend-deploy
git init
git add -A
git commit -m "SUS APC Backend v1.0"
git remote add origin https://github.com/YOUR_USER/sus-apc-backend.git
git push -u origin main
```

#### Step 2: Create Railway Project

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **"New Project"** → **"Deploy from GitHub Repo"**
3. Select your `sus-apc-backend` repository
4. Railway auto-detects Node.js and deploys

#### Step 3: Add Persistent Volume (Critical for SQLite)

1. In your Railway project, click on the service
2. Go to **Settings** → **Volumes**
3. Click **"Add Volume"**
4. Set Mount Path to: `/data`
5. Click **"Add"**

#### Step 4: Set Environment Variables

In Railway → your service → **Variables** tab, add:

```
PORT=3001
DB_PATH=/data/apc_data.db
MQTT_HOST=492260d5d94c4b4e87ade94ae81925e6.s1.eu.hivemq.cloud
MQTT_PORT=8883
MQTT_USER=sus-dashboard
MQTT_PASS=SuS-Mqtt#2026!Secure
MQTT_TOPIC=bus/#
BUS_CAPACITY=55
```

**Important:** `DB_PATH` must point to the mounted volume (`/data/`) so your data survives redeployments.

#### Step 5: Get Your Public URL

1. Go to **Settings** → **Networking**
2. Click **"Generate Domain"** to get a public URL like `sus-apc-backend-production.up.railway.app`
3. Railway provides free HTTPS automatically

#### Step 6: Connect the Dashboard

Open the dashboard's `app.js` and update the `probeBackend()` function to also try your Railway URL:

```javascript
// Add this as the THIRD probe attempt (after same-origin and localhost):
try {
  const res = await fetch('https://YOUR-APP.up.railway.app/api/health', { signal: AbortSignal.timeout(3000) });
  if (res.ok) { API_BASE = 'https://YOUR-APP.up.railway.app'; backendAvailable = true; return true; }
} catch { /* not reachable */ }
```

Then redeploy the dashboard.

#### Verify

```bash
curl https://YOUR-APP.up.railway.app/api/health
```

---

### Option B: VPS with PM2 (Full Control)

For a VPS (DigitalOcean, Hetzner, Linode, AWS EC2, etc.) with Ubuntu/Debian.

#### Step 1: Server Setup

```bash
# SSH into your VPS
ssh user@your-vps-ip

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
sudo npm install -g pm2

# Install build tools for better-sqlite3
sudo apt-get install -y python3 make g++
```

#### Step 2: Deploy the Code

```bash
# Create app directory
sudo mkdir -p /opt/sus-backend
sudo chown $USER:$USER /opt/sus-backend

# Copy files (or git clone)
cd /opt/sus-backend
# Upload server.js, package.json, ecosystem.config.js here

# Install dependencies
npm install --production
```

#### Step 3: Configure Environment

```bash
# Create .env file
cp .env.example .env
# Edit if you need to change any defaults
nano .env
```

Or just use the `ecosystem.config.js` which has all values pre-configured.

#### Step 4: Start with PM2

```bash
# Create logs directory
mkdir -p logs

# Start the application
pm2 start ecosystem.config.js

# Check status
pm2 status
pm2 logs sus-apc-backend

# Save PM2 config (survives reboots)
pm2 save

# Set PM2 to start on boot
pm2 startup
# (follow the instructions it prints)
```

#### Step 5: Set Up Nginx Reverse Proxy (HTTPS)

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Create Nginx config
sudo nano /etc/nginx/sites-available/sus-backend
```

Paste this config:

```nginx
server {
    listen 80;
    server_name your-domain.com;   # Replace with your domain

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable the site
sudo ln -s /etc/nginx/sites-available/sus-backend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# Get free SSL certificate
sudo certbot --nginx -d your-domain.com
```

#### Step 6: Connect the Dashboard

Same as Railway Step 6 — update `probeBackend()` in the dashboard's `app.js` with your VPS URL.

#### Useful PM2 Commands

```bash
pm2 status                        # Check process status
pm2 logs sus-apc-backend          # View logs (live tail)
pm2 logs sus-apc-backend --lines 100  # Last 100 log lines
pm2 restart sus-apc-backend       # Restart
pm2 stop sus-apc-backend          # Stop
pm2 monit                         # Real-time CPU/memory monitor
```

---

### Option C: Docker (Any Platform)

```bash
# Build the image
docker build -t sus-apc-backend .

# Run with persistent volume for SQLite
docker run -d \
  --name sus-backend \
  -p 3001:3001 \
  -v sus-data:/data \
  -e MQTT_HOST=492260d5d94c4b4e87ade94ae81925e6.s1.eu.hivemq.cloud \
  -e MQTT_PORT=8883 \
  -e MQTT_USER=sus-dashboard \
  -e "MQTT_PASS=SuS-Mqtt#2026!Secure" \
  -e MQTT_TOPIC=bus/# \
  sus-apc-backend

# View logs
docker logs -f sus-backend
```

---

## Connecting the Dashboard to the Backend

Once the backend is deployed and running 24/7, the dashboard needs to know where to find it. The dashboard's `probeBackend()` function (in `app.js`, line ~18) auto-detects the backend by probing URLs in order:

1. Same-origin (`/api/health`) — works when backend serves the dashboard HTML directly
2. `http://localhost:3001` — works during local development
3. **Your deployed URL** — you need to add this

### How to Update the Dashboard

In the dashboard's `app.js`, find the `probeBackend()` function and add your backend URL as a third probe. For example:

```javascript
async function probeBackend() {
  if (backendAvailable !== null) return backendAvailable;

  // Try same-origin first
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
    if (res.ok) { API_BASE = ''; backendAvailable = true; return true; }
  } catch { /* not same-origin */ }

  // Try localhost (development)
  try {
    const res = await fetch('http://localhost:3001/api/health', { signal: AbortSignal.timeout(3000) });
    if (res.ok) { API_BASE = 'http://localhost:3001'; backendAvailable = true; return true; }
  } catch { /* not reachable */ }

  // ★ ADD THIS — Try your deployed backend
  try {
    const res = await fetch('https://YOUR-BACKEND-URL.com/api/health', { signal: AbortSignal.timeout(3000) });
    if (res.ok) { API_BASE = 'https://YOUR-BACKEND-URL.com'; backendAvailable = true; return true; }
  } catch { /* not reachable */ }

  backendAvailable = false;
  return false;
}
```

Replace `YOUR-BACKEND-URL.com` with your actual Railway or VPS URL.

---

## Adding More Buses

To add new UR35 gateways / VS125 sensors:

1. **On HiveMQ:** No changes needed — `bus/#` wildcard catches all
2. **On the UR35:** Configure it to publish to `bus/002/telemetry` (or `bus/003`, etc.)
3. **In `server.js`:** Add the gateway to the `GATEWAYS` array:

```javascript
const GATEWAYS = [
  { topic: 'bus/001', label: 'SUS-001', route: '101' },
  { topic: 'bus/002', label: 'SUS-002', route: '205' },   // new bus
  { topic: 'bus/003', label: 'SUS-003', route: '101' },   // another new bus
];
```

4. **In the dashboard's `app.js`:** Add the same entries to `configStore.gateways`

---

## Midnight Reset

At UTC midnight, the server automatically resets in-memory daily counters (`lineIn`, `lineOut`) for all buses. This mirrors the VS125 behaviour — it resets its `line_total_data` counters at midnight. Historical data in SQLite is preserved forever.

---

## Backup

The SQLite database file (`apc_data.db`) contains all your historical data. Back it up regularly:

```bash
# Simple file copy (while server is running — WAL mode makes this safe)
cp /path/to/apc_data.db /path/to/backup/apc_data_$(date +%Y%m%d).db

# Or use SQLite's backup command for maximum safety
sqlite3 /path/to/apc_data.db ".backup '/path/to/backup/apc_data_$(date +%Y%m%d).db'"
```

---

## Files Included

```
sus-backend-deploy/
├── server.js              # Main application (MQTT + SQLite + REST API)
├── package.json           # Node.js dependencies
├── ecosystem.config.js    # PM2 configuration (for VPS deployment)
├── Dockerfile             # Docker image build config
├── Procfile               # Railway / Heroku process file
├── .env.example           # Environment variable template
├── .gitignore             # Git ignore rules
└── README.md              # This file
```

---

## Troubleshooting

### MQTT not connecting
- Check that port 8883 is not blocked by your server's firewall
- Verify credentials: `MQTT_USER` and `MQTT_PASS`
- Check HiveMQ Cloud cluster is active at [console.hivemq.cloud](https://console.hivemq.cloud)

### No data appearing
- Verify VS125 and UR35 are powered on and publishing
- Check MQTT topic: the UR35 should publish to `bus/001/telemetry`
- Look at server logs: `pm2 logs sus-apc-backend` or `docker logs sus-backend`

### better-sqlite3 build fails
- Ensure `python3`, `make`, and `g++` are installed
- On Alpine Linux (Docker): use `node:20-slim` instead of `node:20-alpine`
- On Railway: the Nixpacks buildpack handles this automatically

### Dashboard shows dashes instead of data
- Verify the backend URL is correct in `probeBackend()`
- Check CORS: the backend has `cors()` middleware enabled for all origins
- Open browser DevTools → Network tab → look for `/api/health` requests

---

## License

Proprietary — Smart Urban Sensing Ltd.
