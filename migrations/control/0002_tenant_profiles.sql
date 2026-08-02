-- Purpose: complete tenant configuration as secret references and versioned policy/profile metadata.
CREATE TABLE control.tenant_policies (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  policy_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  configuration jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, policy_key, version)
);
CREATE TABLE control.tenant_identity_providers (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  provider_key text NOT NULL CHECK (provider_key IN ('ENTRA_OIDC','ENTRA_SAML','SWEDEN_CONNECT','TIC_BANKID','FREJA_DIRECT')),
  enabled boolean NOT NULL DEFAULT false,
  public_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_secret_reference text,
  certificate_secret_reference text,
  environment text NOT NULL CHECK (environment IN ('development','test','staging','production')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider_key, environment),
  CHECK (credential_secret_reference IS NULL OR credential_secret_reference ~ '^(vault|aws-kms|azure-keyvault|gcp-secret)://')
);
CREATE TABLE control.tenant_signature_providers (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  provider_key text NOT NULL CHECK (provider_key IN ('SWEDEN_CONNECT_SIGN_SERVICE','INTERNAL_CA','EXTERNAL_TRUST_SERVICE_PROVIDER','RFC3161_TSA')),
  enabled boolean NOT NULL DEFAULT false,
  public_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_reference text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider_key),
  CHECK (secret_reference IS NULL OR secret_reference ~ '^(vault|aws-kms|azure-keyvault|gcp-secret)://')
);
CREATE TABLE control.tenant_storage_profiles (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  version integer NOT NULL CHECK (version > 0),
  region text NOT NULL,
  bucket_reference text NOT NULL,
  object_lock_enabled boolean NOT NULL,
  versioning_enabled boolean NOT NULL,
  active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, version)
);
CREATE TABLE control.tenant_encryption_profiles (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  version integer NOT NULL CHECK (version > 0),
  kms_key_reference text NOT NULL,
  blind_index_key_reference text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, version),
  CHECK (kms_key_reference ~ '^(vault|aws-kms|azure-keyvault|gcp-secret)://'),
  CHECK (blind_index_key_reference ~ '^(vault|aws-kms|azure-keyvault|gcp-secret)://')
);
CREATE TABLE control.tenant_email_profiles (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  version integer NOT NULL CHECK (version > 0),
  sender_domain text NOT NULL,
  sender_address text NOT NULL,
  reply_to text,
  provider_secret_reference text NOT NULL,
  dkim_status text NOT NULL CHECK (dkim_status IN ('pending','verified','failed')),
  dmarc_status text NOT NULL CHECK (dmarc_status IN ('pending','verified','failed')),
  active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, version),
  CHECK (provider_secret_reference ~ '^(vault|aws-kms|azure-keyvault|gcp-secret)://')
);
CREATE TABLE control.tenant_archive_profiles (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  version integer NOT NULL CHECK (version > 0),
  connector_type text NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_reference text,
  active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, version)
);
CREATE TABLE control.tenant_audit_settings (
  tenant_id uuid PRIMARY KEY REFERENCES control.platform_tenants(id),
  export_enabled boolean NOT NULL DEFAULT true,
  retention_days integer,
  external_sink_reference text,
  customer_notification_on_break_glass boolean NOT NULL DEFAULT true
);
CREATE TABLE control.tenant_retention_policies (
  tenant_id uuid NOT NULL REFERENCES control.platform_tenants(id),
  policy_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  mode text NOT NULL CHECK (mode IN ('retain_forever','retain_for_period','archive_then_delete','delete_after_period','legal_hold')),
  period_days integer,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, policy_key, version),
  CHECK ((mode = 'retain_forever' AND period_days IS NULL) OR mode <> 'retain_forever')
);
