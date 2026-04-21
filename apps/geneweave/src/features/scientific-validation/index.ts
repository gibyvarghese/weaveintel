/**
 * Scientific Validation Feature — entry point
 *
 * Exports the route registration function and runner consumed by the geneweave server.
 */

export { registerSVRoutes } from './routes/index.js';
export { SVWorkflowRunner, getSVRunner, resetSVRunner } from './runner.js';
export type { SVRunnerOptions, SVRunInput } from './runner.js';
export { seedSVRecipe, SV_RECIPE_CONFIG, SV_RECIPE_ID } from './recipe.js';
