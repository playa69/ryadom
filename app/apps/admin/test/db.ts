import { createDb } from '@ryadom/db'

/** The test's own connection to the database of this run: it reads and clears what the tests leave. */
export const handle = createDb(process.env.DATABASE_URL!, { max: 2 })
