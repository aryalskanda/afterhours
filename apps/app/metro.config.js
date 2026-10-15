// The app imports the shared protocol (../../packages/protocol, TypeScript source). Metro watches
// that folder, and resolves what the protocol imports (zod, noble) from this app's node_modules,
// so there is one copy of each whichever file imports it.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const protocol = path.resolve(projectRoot, '../../packages/protocol')
const config = getDefaultConfig(projectRoot)

config.watchFolders = [protocol]
const resolve = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromProtocol = context.originModulePath.startsWith(protocol + path.sep)
  const bare = !moduleName.startsWith('.') && !path.isAbsolute(moduleName)
  const next = fromProtocol && bare ? { ...context, originModulePath: path.join(projectRoot, 'package.json') } : context
  return resolve ? resolve(next, moduleName, platform) : next.resolveRequest(next, moduleName, platform)
}

module.exports = config
