/** The web stack's tests switch (add-self-check-tests, D9): on unless the stack is built with `E2E_SELF_CHECK=0`. */
export const SELF_CHECK_ON = process.env.E2E_SELF_CHECK !== '0'
