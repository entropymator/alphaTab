// Compile-time profiling flag. Replaced by the bundler via Vite `define` —
// `false` in every production / test build, `true` only in packages/bench.
// `if (__PROFILING__) { ... }` blocks are dead-code eliminated when false.
declare const __PROFILING__: boolean;
