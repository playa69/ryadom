import { prepareTestDatabase, testDatabase } from '@ryadom/db/test-db'

/**
 * Creates this run's database from the migrated template before the tests and hands back the function that drops
 * it. With DATABASE_URL_TEST_API set the named database is used as it is (emptied and migrated again).
 */
export async function setup(): Promise<() => Promise<void>> {
  return prepareTestDatabase(testDatabase({ explicitUrl: process.env.DATABASE_URL_TEST_API }))
}
