# GCP deployment (manifests ready — with an honest caveat)

Cloud Run, `min=1 max=1` to keep the engine's timers and tmux substrate alive
continuously. ~$35/month at the minimal shape.

**Caveat (read first):** Cloud Run's container filesystem is ephemeral —
across revisions/restarts the SQLite ledger in `/data` is lost unless you mount
a volume. Cloud Run volumes are GCS (FUSE) or NFS; GCS-FUSE is **not**
SQLite-safe. For durable state prefer the Aliyun or AWS recipes, or front this
with your own backup routine (`/data` snapshot on a schedule). This recipe is
provided for completeness of "one command per cloud".

## Deploy

```bash
gcloud run deploy juli \
  --source . \
  --region asia-east1 \
  --min-instances 1 --max-instances 1 --cpu 1 --memory 2Gi \
  --timeout 3600 --concurrency 1 \
  --set-env-vars JULI_DATA_DIR=/data,JULI_LISTEN_HOST=0.0.0.0,LANG=C.UTF-8 \
  --set-secrets JULI_PASSWORD=juli-password:latest \
  --allow-unauthenticated   # engine enforces its own Bearer auth
# then attach your domain (managed TLS is automatic):
gcloud run domain-mappings create --service juli --domain juli.example.com
```

(Or `gcloud run services replace service.yaml` for the declarative form.)

## Notes

- `--concurrency 1`: the engine is a single process with local timers; Cloud
  Run's default concurrency multiplexing is not a fit.
- Create the secret once:
  `echo -n 'your-password' | gcloud secrets create juli-password --data-file=-`
