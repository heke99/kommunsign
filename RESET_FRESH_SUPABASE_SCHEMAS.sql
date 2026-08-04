-- Run the CONTROL section only in the Kommunsign Control project.
-- Run the DATA section only in the Kommunsign Data project.
-- These commands remove only Kommunsign-owned schemas, not auth/storage/public.

-- CONTROL PROJECT
DROP SCHEMA IF EXISTS control CASCADE;
DROP SCHEMA IF EXISTS kommunsign_meta CASCADE;

-- DATA PROJECT (run separately in the Data project)
-- DROP SCHEMA IF EXISTS app CASCADE;
-- DROP SCHEMA IF EXISTS audit CASCADE;
-- DROP SCHEMA IF EXISTS kommunsign_meta CASCADE;
