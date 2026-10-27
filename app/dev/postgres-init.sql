-- Runs once when the volume is created. The ryadom database itself comes from POSTGRES_DB.
-- The unit tests no longer need the two databases below: every run creates one of its own from a migrated
-- template (packages/db/src/test-db.ts). They stay for the old contract, an explicit DATABASE_URL_TEST /
-- DATABASE_URL_TEST_API: ryadom_test for @ryadom/core, ryadom_test_api for @ryadom/api.
CREATE DATABASE ryadom_test OWNER ryadom;
CREATE DATABASE ryadom_test_api OWNER ryadom;

\connect ryadom
CREATE EXTENSION IF NOT EXISTS citext;

\connect ryadom_test
CREATE EXTENSION IF NOT EXISTS citext;

\connect ryadom_test_api
CREATE EXTENSION IF NOT EXISTS citext;
