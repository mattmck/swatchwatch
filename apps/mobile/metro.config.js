// Metro config for the npm-workspaces monorepo. Expo's default config already watches the
// workspace root and resolves hoisted packages; on top of that we pin React to this app's
// copy. The web app hoists a different React patch release to the root node_modules, and
// React Native's renderer must use exactly the React version it was built against, so a
// hoisted package (react-native itself lives at the root) must never pick up the root copy.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

const PINNED = new Set(["react", "react-dom"]);

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const root = moduleName.split("/")[0];
  if (PINNED.has(root)) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(__dirname, "package.json") },
      moduleName,
      platform,
    );
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
