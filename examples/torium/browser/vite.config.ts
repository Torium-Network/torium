import { createLogger, defineConfig } from "vite";

const logger = createLogger();
const warn = logger.warn.bind(logger);
logger.warn = (message, options) => {
  if (
    /externalized for browser compatibility|__vite-browser-external/iu.test(
      message
    )
  ) {
    throw new Error(`Node dependency reached the browser build: ${message}`);
  }
  warn(message, options);
};

export default defineConfig({
  customLogger: logger,
  root: new URL(".", import.meta.url).pathname,
  build: {
    outDir: "../dist/browser",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
});
