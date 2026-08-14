const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../../..");
const exampleRoot = path.resolve(__dirname, "..");
const { getDefaultConfig } = require(
  path.join(exampleRoot, "node_modules/expo/metro-config")
);

const config = getDefaultConfig(exampleRoot);
config.projectRoot = repositoryRoot;
config.watchFolders = [repositoryRoot];
config.resolver.nodeModulesPaths = [
  path.join(exampleRoot, "node_modules"),
  path.join(repositoryRoot, "node_modules"),
];

module.exports = config;
