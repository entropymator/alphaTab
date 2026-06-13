// Compile-time profiling flag. Replaced by the bundler via Vite `define` —
// `false` in every production / test build (via defaultBuildUserConfig and
// defineVitestConfig), `true` only in packages/bench. Call sites use the
// `typeof __PROFILING__ !== 'undefined' && __PROFILING__` pattern so a
// consumer whose vite config never applies the define (e.g. the playground
// in dev mode, or a custom downstream config) won't ReferenceError — the
// typeof check short-circuits cleanly. When the define IS applied, the
// identifier substitution + DCE drops the whole branch.
declare const __PROFILING__: boolean | undefined;
