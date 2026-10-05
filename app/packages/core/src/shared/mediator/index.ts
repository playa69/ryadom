import { Mediator } from 'mediatr-ts'
import { ConcurrencyBehavior, LoggingBehavior } from './pipeline'

/** The single core mediator instance. Modules must not create their own `new Mediator()`. */
export const mediatr = new Mediator()

mediatr.pipelineBehaviors.setOrder([LoggingBehavior, ConcurrencyBehavior])
