// The Rolldown configuration `forge-plugin build` bundles a plugin with. The
// host provides the `forge:` interfaces, so the bundle leaves them as
// imports, which componentizing links to the WIT.
export default {
  external: [/^forge:/],
};
