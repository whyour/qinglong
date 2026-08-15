# Optional Cluster Copilot component

Compose this component only with `../cluster-ai`. It enables the caller-driven
failure-diagnosis capability inside the existing Cluster AI process; it does
not add an HTTP route, queue, watcher, timer, PostgreSQL pool, provider, or
Model Gateway.

Before production use:

1. Replace the example provider, model and egress policy revision in
   `copilot-configmap.yaml`. Keep `config.json` canonical, one-line JSON with
   one trailing newline.
2. Provision these three Secrets out of band, each containing a canonical
   `keyring.json`: `ql3-cluster-ai-copilot-invocation-keyring`,
   `ql3-cluster-ai-copilot-result-keyring`, and
   `ql3-cluster-ai-copilot-output-keyring`.
3. Keep old decryptable keys during rotation. Invocation, Tool result and
   Copilot output keys are independent authorities and must never reuse
   material.
4. Keep Worker ingress and its bounded S3 log-range reader enabled. Startup
   fails closed if the log capability, canonical config, any keyring, or the
   shared successful-completion sink is unavailable.

All projections are read-only mode `0440`. The component adds no Kubernetes
API permission and does not change the default AI-free deployment.
