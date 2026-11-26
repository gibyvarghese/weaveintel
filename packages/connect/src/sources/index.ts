// SPDX-License-Identifier: MIT
/**
 * @weaveintel/connect/sources — source adapters on the generic operation runner (F-L2d). REST is the runner itself;
 * OData is a description turned into the runner's operation and mapping rows.
 */
export { ODATA_COMPARISONS, ODATA_FILTER_INPUT, odataFilter, odataLiteral, odataOperation, type ODataComparison, type ODataField, type ODataFilter, type ODataLiteralType, type ODataOperation, type ODataSource } from './odata.js'
export { SourceReadError, createRunnerSource, odataSourceTable, type PushableFilter, type RunnerCondition, type RunnerOperation, type RunnerSourceCapabilities, type RunnerSourceContext, type RunnerSourceField, type RunnerSourcePort, type RunnerSourceQuery, type RunnerSourceQueryResult, type RunnerSourceSchema, type RunnerSourceTable, type SourceJson } from './virtual.js'
