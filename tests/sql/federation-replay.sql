\set ON_ERROR_STOP on
-- Proves the assertion ledger is what makes replay protection real.
--
-- The in-memory ledger the code shipped with protects nothing that survives a
-- restart, and in a deployment running more than one instance it protected
-- nothing at all -- each process kept its own set, so a replay only had to land
-- on a different instance. These checks are about the table that fixes that.

BEGIN;

\set tenant '''16161616-1616-4161-8161-161616161616'''
\set other '''16161616-9999-4161-8161-161616161616'''

INSERT INTO control.platform_tenants (id, slug, legal_name, organization_number, status)
VALUES (:tenant, 'federation-replay-test', 'Kungalvs kommun', '2120001234', 'active'),
       (:other, 'federation-replay-other', 'Annan kommun', '2120004321', 'active');

-- ===========================================================================
-- 1. An assertion ID is consumed exactly once.
--    The primary key is the mechanism: two replays arriving together cannot
--    both see "not yet consumed" and both win, which a check-then-insert
--    would allow.
-- ===========================================================================
INSERT INTO control.federation_assertion_ledger (tenant_id, assertion_id, not_on_or_after)
VALUES (:tenant, '_a1b2c3d4e5f6', now() + interval '5 minutes');

DO $$ BEGIN
  BEGIN
    INSERT INTO control.federation_assertion_ledger (tenant_id, assertion_id, not_on_or_after)
    VALUES ('16161616-1616-4161-8161-161616161616', '_a1b2c3d4e5f6', now() + interval '5 minutes');
    RAISE EXCEPTION 'GUARD FAILED: the same assertion was consumed twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- The insert that loses is a no-op rather than an error when written the way
-- the repository writes it, and the row count is what tells the two apart.
DO $$
DECLARE consumed integer;
BEGIN
  INSERT INTO control.federation_assertion_ledger (tenant_id, assertion_id, not_on_or_after)
  VALUES ('16161616-1616-4161-8161-161616161616', '_a1b2c3d4e5f6', now() + interval '5 minutes')
  ON CONFLICT (tenant_id, assertion_id) DO NOTHING;
  GET DIAGNOSTICS consumed = ROW_COUNT;
  IF consumed <> 0 THEN
    RAISE EXCEPTION 'GUARD FAILED: a replayed assertion reported itself as newly consumed';
  END IF;

  INSERT INTO control.federation_assertion_ledger (tenant_id, assertion_id, not_on_or_after)
  VALUES ('16161616-1616-4161-8161-161616161616', '_fresh_one', now() + interval '5 minutes')
  ON CONFLICT (tenant_id, assertion_id) DO NOTHING;
  GET DIAGNOSTICS consumed = ROW_COUNT;
  IF consumed <> 1 THEN
    RAISE EXCEPTION 'GUARD FAILED: a first-time assertion was not consumed';
  END IF;
END $$;

-- ===========================================================================
-- 2. The ledger is per tenant. Two municipalities' IdPs can legitimately mint
--    assertions with the same ID, and one must not lock out the other.
-- ===========================================================================
INSERT INTO control.federation_assertion_ledger (tenant_id, assertion_id, not_on_or_after)
VALUES (:other, '_a1b2c3d4e5f6', now() + interval '5 minutes');

-- ===========================================================================
-- 3. Pruning may only remove entries whose assertions can no longer be
--    presented. Deleting one still inside its validity window would reopen
--    exactly the replay this table exists to close.
-- ===========================================================================
INSERT INTO control.federation_assertion_ledger (tenant_id, assertion_id, not_on_or_after)
VALUES (:tenant, '_expired_one', now() - interval '1 minute');

DELETE FROM control.federation_assertion_ledger WHERE not_on_or_after < now();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control.federation_assertion_ledger
              WHERE tenant_id='16161616-1616-4161-8161-161616161616' AND assertion_id='_expired_one') THEN
    RAISE EXCEPTION 'GUARD FAILED: pruning left an entry it should have removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control.federation_assertion_ledger
                  WHERE tenant_id='16161616-1616-4161-8161-161616161616' AND assertion_id='_a1b2c3d4e5f6') THEN
    RAISE EXCEPTION 'GUARD FAILED: pruning removed an assertion still inside its window';
  END IF;
END $$;

-- ===========================================================================
-- 4. An entry must carry the window it can be pruned by. Without it the
--    ledger either grows forever or is pruned on a guess.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO control.federation_assertion_ledger (tenant_id, assertion_id)
    VALUES ('16161616-1616-4161-8161-161616161616', '_no_window');
    RAISE EXCEPTION 'GUARD FAILED: an assertion was recorded with no expiry to prune it by';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
END $$;

-- ===========================================================================
-- 5. The IdP configuration is a row, not code.
--    Migration 0017 replaced the vendor-specific provider list with generic
--    keys precisely so connecting a different IdP -- MobilityGuard, which is
--    what Kungalv runs -- is configuration rather than a code change.
-- ===========================================================================
INSERT INTO control.tenant_identity_providers (tenant_id, provider_key, enabled, environment, public_configuration)
VALUES (:tenant, 'GENERIC_SAML', true, 'production',
        '{"issuer":"https://idp.kungalv.se/saml","audience":"https://kungalv.kommunsign.se/sp","destination":"https://kungalv.kommunsign.se/saml/acs","assignableRoles":["case_manager"]}'::jsonb);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM control.tenant_identity_providers
                  WHERE tenant_id='16161616-1616-4161-8161-161616161616'
                    AND provider_key='GENERIC_SAML' AND enabled) THEN
    RAISE EXCEPTION 'GUARD FAILED: a generic SAML provider could not be configured';
  END IF;
END $$;

SELECT 'federation replay guards: OK' AS result;

ROLLBACK;
