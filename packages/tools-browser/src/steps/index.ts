// SPDX-License-Identifier: MIT
/**
 * @weaveintel/tools-browser/steps: do in a browser what no API can, from steps written as data.
 *
 *   runSteps(driver, steps, { allowHosts, answers })   run goto/fill/choose/pick/check/click/expect/read steps
 *   stepsForAnswers(answers)                           answered form questions → steps, by question kind
 *   playwrightDriver(page)                             find fields by label, buttons by name, options by text
 *
 * A connector pack declares the steps (for example "open the item's page, fill the form, press Submit, expect a
 * record number"). The runner keeps every run to allowlisted hosts and a step limit. It never types a
 * credential-shaped value and logs each step for evidence.
 */
export { runSteps, stepsForAnswers, type AnsweredQuestion, type RunOptions, type RunResult, type StepDriver, type StepLog, type UiStep } from './runner.js'
export { playwrightDriver } from './playwright.js'
