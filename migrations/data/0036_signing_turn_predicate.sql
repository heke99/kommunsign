-- Purpose: Give "is it this signer's turn yet?" one definition in the database, and make the reminder job obey it.
-- Impact: Adds app.signing_turn_blocked(uuid, uuid). No table, column or row is changed. Callers switch to the function in the same change.
-- Backfill: Nothing to backfill. The function derives its answer from app.signers as it stands.
-- Rollback: Drop the function and restore the inline predicate in the two callers that had it. No data depends on it.
-- Verification: tests/sql/signing-turn.sql covers sequential, parallel, optional signers and a declined predecessor.

-- ---------------------------------------------------------------------------
-- Three callers, two of which agreed
--
-- The order check existed twice as an inline EXISTS: once where a signer starts
-- BankID (SIGNING_ORDER_BLOCKED) and once where the next group is invited. Both
-- were correct and identical. The reminder job was the third place the question
-- gets asked, and it did not ask it at all — it reminded every signer in
-- 'invited' or 'opened', which is how signer three receives a nagging email
-- about a document that will refuse to open for them.
--
-- Putting the predicate in the database rather than in a shared TypeScript
-- helper is deliberate: the API and the worker are separate processes with
-- separate deployments, and a shared module still ships as two copies that can
-- be at different versions for the length of a rollout. The database is the one
-- thing both are guaranteed to share.
--
-- STABLE, not IMMUTABLE: the answer changes as signers sign.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.signing_turn_blocked(p_tenant_id uuid, p_signer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.signers target
    JOIN app.signers lower
      ON lower.tenant_id = target.tenant_id
     AND lower.signature_case_id = target.signature_case_id
     AND lower.signing_order < target.signing_order
     AND lower.required
     AND lower.status <> 'signed'
    WHERE target.tenant_id = p_tenant_id
      AND target.id = p_signer_id
  );
$$;

COMMENT ON FUNCTION app.signing_turn_blocked(uuid, uuid) IS
  'True when a required signer in an earlier signing_order has not signed. Parallel cases share one signing_order, so nothing is ever blocked. Optional signers never block, by design: an optional approver who never answers must not be able to stall a decision indefinitely.';
