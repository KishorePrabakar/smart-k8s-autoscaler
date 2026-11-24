# Smart Kubernetes Autoscaler – Demo

A demo of a predictive, cost-aware autoscaler for Kubernetes. The frontend pages are static HTML and the backend is a mock API, so the demo runs without a real cluster.

## Project layout

```
smart-k8s-autoscaler/
├── frontend/
│   ├── index.html            # Autoscaler console (policy sliders, load vs capacity chart, decision log)
│   ├── cluster-view.html     # Pod map and service table
│   ├── timeline-view.html    # 24h pods timeline and event feed
│   ├── tradeoff-view.html    # Cost vs latency trade-off explorer
│   └── alerts-view.html      # Scaling alert triage
├── docs/
│   └── figures/
│       ├── ch8-graph.html    # Figure 8.1 – black and white bar graph
│       └── ch8-explainer.html# Figure 8.2 – scaling loop diagram
├── backend/
│   ├── server.js             # Mock backend + static file server (no dependencies)
│   └── package.json
└── README.md
```

## Requirements

- Node.js 18 or newer (`node -v` to check)
- A browser

## Run the demo

### Option A: full demo with the mock backend (recommended)

```bash
cd smart-k8s-autoscaler
node backend/server.js
```

Then open:

- http://localhost:3000/ (console)
- http://localhost:3000/cluster-view.html
- http://localhost:3000/timeline-view.html
- http://localhost:3000/tradeoff-view.html
- http://localhost:3000/alerts-view.html
- http://localhost:3000/figures/ch8-graph.html

To use another port: `PORT=8080 node backend/server.js`

### Option B: frontend only

The pages simulate their data in the browser, so they also work without the backend:

```bash
cd smart-k8s-autoscaler/frontend
python3 -m http.server 8000
```

Then open http://localhost:8000/

## Mock backend

The backend in `backend/server.js` returns fake data in the same shape a real controller would. It needs no database or cluster.

| Method | Endpoint | What it returns |
|---|---|---|
| GET | `/api/health` | Service status |
| GET | `/api/metrics` | Current load, pod count, p99 latency, cost index, SLO breach flag |
| GET | `/api/services` | Per-service pods, utilization, latency, status |
| GET | `/api/timeline?hours=24` | 96 points (15-minute buckets) of smart vs HPA pod counts and breach flags |
| POST | `/api/tradeoff` | Body `{"target":70,"minReplicas":3}`, returns pods, cost, p99 and SLO result |
| GET / PUT | `/api/policy` | Read or update mode, min/max replicas, SLO, horizon, capacity per pod |
| GET | `/api/alerts?sev=all` | Alert list, filterable by `crit`, `warn`, `info` |
| POST | `/api/alerts/:id/ack` | Toggle acknowledged state of one alert |

Try them with curl:

```bash
curl http://localhost:3000/api/metrics
curl -X PUT -H "Content-Type: application/json" -d '{"mode":"hpa"}' http://localhost:3000/api/policy
curl -X POST -H "Content-Type: application/json" -d '{"target":80,"minReplicas":4}' http://localhost:3000/api/tradeoff
```

### How the mock maps to a real system

When you replace the mock with a real controller, each part of the design maps to one component:

| Demo part | Real component |
|---|---|
| `/api/metrics`, `/api/services` | Prometheus queries (kube-state-metrics, cAdvisor) |
| Forecast values in `/api/metrics` | LoadPredictor service (seasonal and trend model) |
| `podsFor()` in `server.js` | ScalingEngine: replica calculation with min/max and SLO guardrails |
| `/api/policy` | A `SmartScaler` custom resource read and written through the Kubernetes API |
| `/api/alerts` | Alertmanager or the controller's event stream |
| `/api/timeline` | Stored history from the time-series database |

To go from mock to real, keep the same routes and swap each handler's body for a call to the real source. The frontend pages do not need to change.

## Note on the frontend

The five HTML pages generate their numbers in the browser, so they do not call `/api/*` yet. Connecting them is the next step: replace each page's simulation function with a `fetch('/api/...')` call on the same interval. The look and layout stay the same.

## Push to GitHub

Run these from the `smart-k8s-autoscaler` folder. They assume git and the GitHub CLI (`gh`) are installed and you are logged in (`gh auth login`).

```bash
cd smart-k8s-autoscaler
git init
git branch -M main
git add .
git commit -m "Initial commit: Smart Kubernetes Autoscaler demo

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SSSAQHxtQD3XcFmcJqXZdY"
gh repo create smart-k8s-autoscaler --public --source=. --remote=origin --push
```

To create the repo on GitHub with the web UI instead, make an empty repo named `smart-k8s-autoscaler`, then run:

```bash
git remote add origin https://github.com/<your-username>/smart-k8s-autoscaler.git
git push -u origin main
```

## Notes

- All numbers in the demo are simulated or placeholders, not measured results.
- Figure 8.1's values are illustrative. Replace them with your measured data.
