// pi's extension loader maps the legacy package name to its compat entrypoint.
// Check against the real supported runtime types rather than a handwritten ABI.
declare module "@mariozechner/pi-ai" {
	export * from "@earendil-works/pi-ai/compat";
}
