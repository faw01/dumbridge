// Bun bundles `with { type: "text" }` imports as strings at build time.
declare module "*.md" {
  const text: string;
  export default text;
}
