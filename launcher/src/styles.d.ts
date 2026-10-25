// Vite handles CSS side-effect imports at build time.
// Preserve TypeScript 7's side-effect import checking for non-CSS modules.
declare module "*.css";
