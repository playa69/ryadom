import { describe, expect, it } from 'vitest'
import { shareViewsText } from './dialog-share'

describe('shareViewsText', () => {
  it('склоняет просмотры', () => {
    expect([0, 1, 2, 5, 11, 12, 21, 22, 25, 111].map(shareViewsText)).toEqual([
      '0 просмотров',
      '1 просмотр',
      '2 просмотра',
      '5 просмотров',
      '11 просмотров',
      '12 просмотров',
      '21 просмотр',
      '22 просмотра',
      '25 просмотров',
      '111 просмотров',
    ])
  })
})
