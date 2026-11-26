// SPDX-License-Identifier: MIT
/**
 * @weaveintel/connect/forms: ask a person an application's form and submit their answers, the same way for every
 * application.
 *
 *   fromDefinition(def, mapping)       an application's own form definition → FormSpec (the mapping is pack data)
 *   nextQuestions / applicable         what to ask now, after the form's show/hide/require rules
 *   toElicitation / fromElicitation    ask through MCP elicitation (form mode), read the reply
 *   validate / normalise               check answers; choice labels → values, lookups → ids, time zones converted
 *   summarise                          the answers in the person's words, for the yes before a write
 *   guidedSubmit                       the whole loop, with asking, lookup and submit supplied by the caller
 */
export { QUESTION_KINDS, type Answer, type AnswerFormats, type Answers, type Choice, type Condition, type FormSpec, type Question, type QuestionKind, type Rule, type Value } from './spec.js'
export { applicable, choiceValue, nextQuestions, normalise, summarise, validate, type Applicable, type Normalised, type Problem } from './answers.js'
export { fromElicitation, toElicitation, type ElicitationRequest, type ElicitationResult, type PrimitiveSchema } from './elicitation.js'
export { at, fromDefinition, type FormMapping, type FromDefinitionOptions } from './mapping.js'
export { guidedSubmit, type Candidate, type GuidedInput, type GuidedResult } from './guided.js'
export { instantOf, isZone, offsetMinutes, readDateTime, writeDateTime } from './zones.js'
