# Optional Cluster AI component

This component replaces only the Cluster Control image with the explicit
`runtime-ai` target. The default Cluster deployment and image remain AI-free.

Before applying it:

1. Replace the example Project, provider URL, model and policy revision in
   `provider-authority-configmap.yaml`; keep `authority.json` canonical,
   one-line JSON with one trailing newline.
2. Bind the same Project/provider to a canonical SecretRef through the
   append-only model-provider credential catalog.
3. Project each provider authorization value under the lowercase SHA-256 of
   its canonical SecretRef. Use `provider-secrets.example.yaml` only as a
   shape reference and provision the real Secret through a Secret manager.
4. Build and publish the Docker `runtime-ai` target, then pin its independent
   digest in a private overlay based on `private-overlay.example.yaml`.

The component mounts ConfigMap and Secret volumes read-only with mode `0440`,
does not mount a ServiceAccount token, and grants no Kubernetes API access.
It remains live-output-only by default. Compose the separate
`../cluster-ai-prompt-output` component only when encrypted durable Prompt
output and its externally provisioned keyring are required.
Each replica adds a separate, bounded PostgreSQL runtime pool of four
connections by default; tune `QL3_CLUSTER_AI_DATABASE_MAX_CONNECTIONS` and
`QL3_CLUSTER_AI_MAX_CONCURRENT` together for the cluster's resource budget.
