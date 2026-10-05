-- Runs once when the volume is created. The ryadom database itself comes from POSTGRES_DB.
-- Each package gets its own test database so that parallel turbo runs do not interfere:
-- ryadom_test for @ryadom/core, ryadom_test_api for @ryadom/api.
CREATE DATABASE ryadom_test OWNER ryadom;
CREATE DATABASE ryadom_test_api OWNER ryadom;

\connect ryadom
CREATE EXTENSION IF NOT EXISTS citext;

\connect ryadom_test
CREATE EXTENSION IF NOT EXISTS citext;

\connect ryadom_test_api
CREATE EXTENSION IF NOT EXISTS citext;
