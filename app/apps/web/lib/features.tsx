'use client'

import { createContext, useContext, type ReactNode } from 'react'

/** Switches the server decides per request (the pod's environment), handed to the client at render. */
export interface Features {
  /** The mood diary (`DIARY_ENABLED`, `REQ-WELL-01`): the sidebar item and the pages. */
  diary: boolean
}

const FeaturesContext = createContext<Features>({ diary: false })

export function FeaturesProvider({ features, children }: { features: Features; children: ReactNode }) {
  return <FeaturesContext.Provider value={features}>{children}</FeaturesContext.Provider>
}

export function useFeatures(): Features {
  return useContext(FeaturesContext)
}
