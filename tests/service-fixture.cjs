'use strict';
const path = require('node:path');
const server = require('../runtime/server.cjs');
const services = new Map();

// Infrastructure tests construct peers in process. Public connection behavior is
// covered through the real connect endpoint and CLI in connect.test.cjs.
async function serve(root, options) {
  const service = await server.serve(root, options), key = path.resolve(root), close = service.close;
  services.set(key, service);
  service.close = async () => { if (services.get(key) === service) services.delete(key); await close(); };
  return service;
}
function desktop(root) {
  const service = services.get(path.resolve(root));
  if (!service) throw Error('No fixture service registered for ' + root);
  return service.admin.desktop;
}
async function registerDesktop(root, input) { return desktop(root).attach(input); }
async function bindWake(root, identity, input) { desktop(root); return services.get(path.resolve(root)).monitor.wake.bind(identity, input); }
function fakeWake(workspace) { const read=async b=>({thread:{id:b.threadId,cwd:workspace,status:{type:'active'}}});return {read,verify:read,resolveTurn:async()=> 'fixture-turn',send:async()=>{throw Error('No model calls authorized by this fixture');}}; }
module.exports = { fakeWake, serve, registerDesktop, bindWake, validateConfig:server.validateConfig };
