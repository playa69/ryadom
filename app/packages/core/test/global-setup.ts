import { prepareTestDatabase, testDatabase } from '@ryadom/db/test-db'

/** Creates this run's database from the migrated template before the tests and hands back the function that drops it. */
export async function setup(): Promise<() => Promise<void>> {
  return prepareTestDatabase(testDatabase())
}
