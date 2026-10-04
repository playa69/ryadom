export interface ConsentStatusDTO {
  /** All three agreements are on record, in some version of the terms. */
  completed: boolean
  /** The newest version of the terms the person accepted; null before the first acceptance. */
  offerVersion: string | null
}

export interface GetConsentStatusResult {
  success: true
  status: ConsentStatusDTO
}
