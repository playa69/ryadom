/**
 * TS mirror of `tokens.css`, for contexts that cannot read CSS custom properties — today just
 * the emails (`@react-email/components` renders to static HTML with inline styles, and CSS
 * custom properties are not reliable across mail clients). `tokens.css` is the one to edit
 * first; keep the values below in sync with it.
 *
 * Not a complete mirror on purpose: CSS-only concerns with no email use (the ambient gradient,
 * the stars, the focus ring) are not duplicated here as inert data.
 */
export const tokens = {
  paper: '#00051a',
  surface: '#0e1631',
  surface2: '#151f40',
  surface3: '#1d2854',
  line: 'rgba(255, 255, 255, 0.1)',
  lineStrong: 'rgba(255, 255, 255, 0.36)',

  text: '#f1f4ff',
  textDim: '#b0b9d8',
  textFaint: '#93a0c8',

  brand: '#007aff',
  brand400: '#4da3ff',
  brandFill: '#0070f0',
  brand50: 'rgba(0, 122, 255, 0.14)',
  brand100: 'rgba(0, 122, 255, 0.34)',
  peach: '#e8a972',

  sage: '#79d2c2',
  sage50: 'rgba(121, 210, 194, 0.12)',
  sage100: 'rgba(121, 210, 194, 0.28)',

  mood1: '#e5645f',
  mood2: '#ee9a55',
  mood3: '#e9d36b',
  mood4: '#86cf86',
  mood5: '#4ec5d9',
  danger: '#ff7a7a',
  danger600: '#d13333',
  danger50: 'rgba(255, 107, 107, 0.12)',
  danger100: 'rgba(255, 107, 107, 0.28)',

  sos: '#ff6a6f',

  font: "'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",

  radiusS: '14px',
  radiusM: '20px',
  radiusL: '28px',
  radiusXl: '36px',
  radiusPill: '999px',

  shadow1: '0 2px 12px rgba(2, 5, 20, 0.4)',
  shadow2: '0 24px 60px -12px rgba(2, 5, 20, 0.7)',

  space1: '4px',
  space2: '8px',
  space3: '12px',
  space4: '16px',
  space5: '20px',
  space6: '24px',
  space7: '32px',
  space8: '40px',

  textXs: '12px',
  textSm: '13px',
  textBase: '15px',
  textMd: '16px',
  textLg: '19px',
  textXl: '22px',
  text2xl: '26px',
  text3xl: '32px',
  text4xl: '40px',
  text5xl: '56px',
} as const
