/**
 * Browser entry point for the offline engine.
 *
 * This file exists only to be bundled: `scripts/build.mjs` compiles it with
 * esbuild into `public/engine.js`, an IIFE that exposes `window.ForwardCheckEngine`.
 * The front-end then runs the very same heuristics, claim extractor and verdict
 * fusion the Worker uses, so a static deployment (or an offline tab) still
 * produces a complete report instead of an error.
 */

import { offlineReport, buildQueries, PROVIDER_META } from './offline.js';
import { SAMPLES } from './samples.js';

export { offlineReport, buildQueries, PROVIDER_META, SAMPLES };
