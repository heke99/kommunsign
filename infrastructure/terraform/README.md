# Production IaC gate

Cloud/provider selection is intentionally not guessed. Before applying production IaC, record an ADR for:

- Swedish/EU data residency,
- managed PostgreSQL and object-lock support,
- KMS/HSM and key ceremony,
- WAF/DDoS,
- private networking and egress allowlists,
- immutable backup vault and cross-region recovery,
- customer-hosted deployment requirements.

Kubernetes manifests in `infrastructure/kubernetes/base` are the provider-neutral workload baseline. Replace every digest placeholder through the signed release pipeline; never deploy a floating `latest` image.
