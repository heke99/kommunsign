\set ON_ERROR_STOP on
-- Proves the controls around directory provisioning. The risk here is not data
-- loss, it is silent privilege: a directory admin adding someone to a group
-- must never grant more than the provisioning credential was scoped for, and a
-- leaver's history must survive their deprovisioning.

BEGIN;

SELECT set_config('app.actor_kind', 'internal_user', true);
SELECT set_config('app.tenant_id', '15151515-1515-4151-8151-151515151515', true);

\set tenant '''15151515-1515-4151-8151-151515151515'''
\set adminrole '''15151515-1111-4151-8151-151515151515'''
\set readerrole '''15151515-2222-4151-8151-151515151515'''
\set client '''15151515-3333-4151-8151-151515151515'''
\set userid '''15151515-4444-4151-8151-151515151515'''
\set hash32 '''\\x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'''

INSERT INTO app.organizations (tenant_id, id, legal_name)
VALUES (:tenant, '15151515-0000-4151-8151-151515151515', 'Kungalvs kommun');
INSERT INTO app.roles (tenant_id, id, role_key, permissions) VALUES
  (:tenant, :adminrole, 'tenant_admin', '["tenant:manage"]'::jsonb),
  (:tenant, :readerrole, 'readonly', '["case:read"]'::jsonb);

-- ===========================================================================
-- 1. The credential is a hash, and a full one.
--    Anything shorter would mean the lookup matches on something else.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.scim_provisioning_clients (tenant_id, id, display_name, token_hash, assignable_roles, enabled)
    VALUES ('15151515-1515-4151-8151-151515151515', '15151515-3333-4151-8151-151515151515',
            'Katalogsync', '\x0011'::bytea, ARRAY['readonly'], true);
    RAISE EXCEPTION 'GUARD FAILED: a truncated token hash was accepted as a credential';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%scim_clients_token_hash_length%' THEN
      RAISE EXCEPTION 'WRONG GUARD FIRED: %', SQLERRM;
    END IF;
  END;
END $$;

-- Issuing without a secret-manager reference is normal: the token is returned
-- once at creation and kept only as its hash, so there is nothing to reference.
INSERT INTO app.scim_provisioning_clients (tenant_id, id, display_name, token_hash, assignable_roles, enabled)
VALUES (:tenant, :client, 'Katalogsync', :hash32::bytea, ARRAY['readonly'], true);

-- ===========================================================================
-- 2. Two clients cannot share a token.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.scim_provisioning_clients (tenant_id, display_name, token_hash, assignable_roles, enabled)
    VALUES ('15151515-1515-4151-8151-151515151515', 'Kopia', 
            '\x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'::bytea, ARRAY['readonly'], true);
    RAISE EXCEPTION 'GUARD FAILED: two provisioning clients shared one token';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- ===========================================================================
-- 3. A group mapping is a row per grant, individually revocable, and it must
--    point at a role that exists in this tenant.
-- ===========================================================================
INSERT INTO app.scim_group_role_mappings (tenant_id, client_id, group_value, role_id)
VALUES (:tenant, :client, 'CN=Kommunsign-Lasare,OU=Grupper', :readerrole);

DO $$ BEGIN
  BEGIN
    INSERT INTO app.scim_group_role_mappings (tenant_id, client_id, group_value, role_id)
    VALUES ('15151515-1515-4151-8151-151515151515', '15151515-3333-4151-8151-151515151515',
            'CN=Nagon-Annan-Tenant', '99999999-9999-4999-8999-999999999999');
    RAISE EXCEPTION 'GUARD FAILED: a group was mapped to a role outside this tenant';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- Group values are stored verbatim. Case-folding a distinguished name can
-- collide two genuinely distinct groups, so two casings are two mappings.
INSERT INTO app.scim_group_role_mappings (tenant_id, client_id, group_value, role_id)
VALUES (:tenant, :client, 'cn=kommunsign-lasare,ou=grupper', :readerrole);

-- ===========================================================================
-- 4. A provisioned user is a row in app.users, not a parallel model.
--    Uniqueness is per tenant: two municipalities legitimately have a user
--    with the same directory identifier.
-- ===========================================================================
INSERT INTO app.users (tenant_id, id, external_subject, display_name, scim_external_id, scim_user_name)
VALUES (:tenant, :userid, 'anna@kungalv.se', 'Anna Andersson', 'dir-0001', 'anna@kungalv.se');

DO $$ BEGIN
  BEGIN
    INSERT INTO app.users (tenant_id, external_subject, display_name, scim_external_id, scim_user_name)
    VALUES ('15151515-1515-4151-8151-151515151515', 'annan@kungalv.se', 'Dubblett', 'dir-0001', 'annan@kungalv.se');
    RAISE EXCEPTION 'GUARD FAILED: one directory identifier provisioned two accounts';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    INSERT INTO app.users (tenant_id, external_subject, display_name, scim_external_id, scim_user_name)
    VALUES ('15151515-1515-4151-8151-151515151515', 'x@kungalv.se', 'Samma login', 'dir-0002', 'ANNA@kungalv.se');
    RAISE EXCEPTION 'GUARD FAILED: two directory entries claimed the same login';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- ===========================================================================
-- 5. Roles reach a user through the existing membership model, so the rest of
--    the system can see the grant. A SCIM-only shortcut would create
--    authorisation nothing else knows about.
-- ===========================================================================
INSERT INTO app.memberships (tenant_id, id, user_id, department_id, status)
VALUES (:tenant, '15151515-5555-4151-8151-151515151515', :userid, NULL, 'active');
INSERT INTO app.role_assignments (tenant_id, membership_id, role_id)
VALUES (:tenant, '15151515-5555-4151-8151-151515151515', :readerrole);

-- ===========================================================================
-- 6. Deprovisioning keeps the history.
--    A leaver's signatures and audit entries must survive their departure, or
--    the trail develops holes exactly where a leaver is involved.
-- ===========================================================================
INSERT INTO app.scim_provisioning_events (tenant_id, client_id, user_id, action, detail)
VALUES (:tenant, :client, :userid, 'DEACTIVATED', '{"active":false}'::jsonb);

UPDATE app.users SET disabled_at = now() WHERE tenant_id = :tenant AND id = :userid;
UPDATE app.memberships SET status = 'disabled' WHERE tenant_id = :tenant AND user_id = :userid;

DO $$ BEGIN
  IF (SELECT disabled_at FROM app.users WHERE tenant_id='15151515-1515-4151-8151-151515151515' AND id='15151515-4444-4151-8151-151515151515') IS NULL THEN
    RAISE EXCEPTION 'GUARD FAILED: deactivation did not take effect';
  END IF;
  -- The row is still there, which is the entire point.
  IF NOT EXISTS (SELECT 1 FROM app.users WHERE tenant_id='15151515-1515-4151-8151-151515151515' AND id='15151515-4444-4151-8151-151515151515') THEN
    RAISE EXCEPTION 'GUARD FAILED: deprovisioning destroyed the user row';
  END IF;
  -- And the provisioning trail records what happened (requirement 3518).
  IF NOT EXISTS (SELECT 1 FROM app.scim_provisioning_events
                  WHERE tenant_id='15151515-1515-4151-8151-151515151515'
                    AND user_id='15151515-4444-4151-8151-151515151515' AND action='DEACTIVATED') THEN
    RAISE EXCEPTION 'GUARD FAILED: deprovisioning left no trail';
  END IF;
END $$;

-- ===========================================================================
-- 7. The provisioning trail is per tenant and cannot name a client from
--    another one.
-- ===========================================================================
DO $$ BEGIN
  BEGIN
    INSERT INTO app.scim_provisioning_events (tenant_id, client_id, user_id, action, detail)
    VALUES ('15151515-1515-4151-8151-151515151515', '99999999-9999-4999-8999-999999999999',
            '15151515-4444-4151-8151-151515151515', 'UPDATED', '{}'::jsonb);
    RAISE EXCEPTION 'GUARD FAILED: a provisioning event named a client from another tenant';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

SELECT 'scim provisioning guards: OK' AS result;

ROLLBACK;
