# QueryVault — Production Container (Phase 6B)

Packages the Phase 6A–verified Node runtime (`NITRO_PRESET=node-server` →
`.output/server/index.mjs`) into an image suitable for ECR/ECS Fargate.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | 3-stage build: Bun deps → Node 22 Vite/Nitro build → Node 22 slim runtime |
| `.dockerignore` | Keeps secrets, tests, `node_modules`, `.output`, and local-only material out of the build context |
| `docker-compose.yml` | Local verification harness (read-only rootfs, dropped caps, non-root) |
| `.env.docker.example` | Documents the runtime environment contract — contains no values |

## Build

```bash
docker build \
  --platform linux/amd64 \
  --build-arg VITE_SUPABASE_URL="$VITE_SUPABASE_URL" \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY="$VITE_SUPABASE_PUBLISHABLE_KEY" \
  --build-arg VITE_SUPABASE_PROJECT_ID="$VITE_SUPABASE_PROJECT_ID" \
  -t queryvault:local -t queryvault:$(git rev-parse --short HEAD) .
```

Only browser-safe publishable values are build args — Vite inlines them into
the client bundle, so they are public by definition. **No server secret is ever
a build arg or an image layer.**

## Run

```bash
docker run --rm -p 3000:3000 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --user 1000:1000 \
  -e SUPABASE_URL -e SUPABASE_PUBLISHABLE_KEY -e SUPABASE_SERVICE_ROLE_KEY \
  -e LOVABLE_API_KEY -e INGESTION_WORKER_SECRET -e QV_RELEASE \
  queryvault:local
```

Or `docker compose up --build` after exporting the same variables.

## Environment contract

Server-only (runtime injection: ECS task definition `secrets` → Secrets Manager):

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LOVABLE_API_KEY`
- `INGESTION_WORKER_SECRET`
- `QV_RELEASE`

Browser-safe (build-time inline):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Runtime knobs: `PORT` (default 3000), `HOST` (default 0.0.0.0).

## Filesystem posture

The application performs no runtime filesystem writes: PDF parsing (`unpdf`)
operates on in-memory buffers, storage is Supabase, jobs are Postgres rows, and
logs go to stdout. The container therefore runs `--read-only`.

`/tmp` is mounted as a 64 MB `noexec,nosuid` tmpfs — **not** for application
use. It exists because the Node/V8 runtime may emit diagnostic reports or
source-map scratch data on abnormal conditions and would otherwise fail on a
fully read-only rootfs. No application directory is writable.

## Shutdown

Node is PID 1, so `SIGTERM` reaches the Nitro server directly and its graceful
close runs (verified in Phase 6A). `stop_grace_period` / ECS
`stopTimeout` should be ≥ 30s so in-flight streaming chat responses finish.

## Verification checklist

```bash
curl -si localhost:3000/ | head -1
curl -s  localhost:3000/api/public/health
curl -si localhost:3000/api/public/health?probe=live | head -1
curl -si -X POST localhost:3000/api/chat -d '{}' | head -1   # expect 401
docker exec <id> id                                           # expect uid=1000
docker history queryvault:local
docker kill --signal=SIGTERM <id>
```

## Not in this phase

ECR repositories, ECS/Fargate services, VPC, ALB, CloudFront, WAF, and the
SQS/EventBridge ingestion migration (Phase 6H). The dedicated ingestion-worker
container and its own SIGTERM drain semantics are also Phase 6H.
