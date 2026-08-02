-- Purpose: establish tenant data-plane schemas, enums and immutable status vocabulary.
-- Impact: Creates tenant data-plane schemas and immutable enum vocabularies.
-- Backfill: No data backfill; initial schema.
-- Rollback: Drop dependent objects first, then types and schemas in a maintenance window.
-- Verification: Confirm required schemas, extension and enum values exist.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TYPE app.case_status AS ENUM ('draft','preparing','ready','sent','in_progress','partially_signed','completed','declined','expired','cancelled','failed','archiving','archived');
CREATE TYPE app.signer_status AS ENUM ('pending','invited','opened','identity_started','identity_verified','signing','signed','declined','expired','cancelled','failed');
CREATE TYPE app.document_status AS ENUM ('uploaded','quarantined','scanning','rejected','canonicalizing','ready','locked','partially_signed','signed','validated','archived');
CREATE TYPE app.decision_mode AS ENUM ('DIGITAL_APPROVAL','ELECTRONIC_SIGNATURE');
CREATE TYPE app.identity_provider AS ENUM ('TIC_BANKID','FREJA_DIRECT','TEST_ONLY');
CREATE TYPE app.validation_indication AS ENUM ('TOTAL_PASSED','INDETERMINATE','TOTAL_FAILED');
CREATE TYPE app.information_classification AS ENUM ('PUBLIC','INTERNAL','CONFIDENTIAL','HIGHLY_CONFIDENTIAL','SECURITY_PROTECTED_NOT_ALLOWED');
CREATE TYPE app.job_status AS ENUM ('pending','leased','completed','dead_letter');
