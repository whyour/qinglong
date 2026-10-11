# Kubernetes deployment

This deploys Qinglong as a single-replica `StatefulSet` with persistent data at `/ql/data`.

```bash
kubectl apply -k deploy/kubernetes/overlays/local
kubectl -n qinglong rollout status statefulset/qinglong
```

Open the panel locally:

```bash
kubectl -n qinglong port-forward svc/qinglong 5700:5700
```

Then visit <http://127.0.0.1:5700>.

## Image registry overlays

Use `overlays/example` as the committed template for registry customization:

```yaml
whyour/qinglong:debian -> registry.example.com/whyour/qinglong:debian
```

Create `overlays/local/kustomization.yaml` for the actual cluster image. The `local` overlay is ignored by git so private registry names, digests, and credentials-related references stay local.

## Storage

The manifest creates a 5 GiB `ReadWriteOnce` PVC from the cluster's default `StorageClass`.
If your cluster has no default storage class, add `storageClassName` under:

```yaml
volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      storageClassName: your-storage-class
```

Keep `replicas: 1`. Qinglong stores state in the persistent data directory, including SQLite files, so multiple replicas should not share the same data volume.

## Ingress example

If you expose Qinglong through an Ingress path other than `/`, set `QlBaseUrl` to the same path with leading and trailing slashes.

```yaml
env:
  - name: QlBaseUrl
    value: "/qinglong/"
```

Example Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: qinglong
  namespace: qinglong
spec:
  rules:
    - host: qinglong.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: qinglong
                port:
                  number: 5700
```

## Maintenance commands

```bash
kubectl -n qinglong logs -f statefulset/qinglong
kubectl -n qinglong exec -it statefulset/qinglong -- ql check
kubectl -n qinglong exec -it statefulset/qinglong -- ql update
```
