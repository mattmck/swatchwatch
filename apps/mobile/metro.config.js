// Metro config. Expo's default already handles the npm-workspaces monorepo (watches the
// workspace root, resolves hoisted packages). The repo keeps a single React copy via the
// root package.json `overrides` (React Native's renderer must match React exactly).
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
