import { runLoginStage } from '../src/client/login-stage.js';
const user = process.argv[2] ?? 'tslive09';
const login = await runLoginStage({
  endpoint: { host: '10.254.0.253', port: 44453 },
  username: user,
});
console.log(`account=${user}`);
console.log(`characters (${login.characters.length}):`);
for (const c of login.characters) {
  console.log(`  ${c.name}  oid=${c.networkId}  cluster=${c.clusterId}  type=${c.characterType}`);
}
console.log(`clusters (${login.clusters.length}):`);
for (const cl of login.clusters) {
  console.log(`  ${cl.name}  id=${cl.id}  conn=${cl.connectionServerAddress}:${cl.connectionServerPort}  status=${cl.status}  pop=${cl.populationStatus}`);
}
process.exit(0);
