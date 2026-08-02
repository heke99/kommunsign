import { spawn } from 'node:child_process';

const commands = [
  ['npm', ['run', 'dev:website']],
  ['npm', ['run', 'dev:platform-admin']],
  ['npm', ['run', 'dev:tenant']],
  ['npm', ['run', 'dev:signer']],
  ['npm', ['run', 'dev:verify']],
  ['npm', ['run', 'dev:api']],
];
const children = commands.map(([command, args]) => spawn(command, args, { stdio: 'inherit', env: process.env }));
function stop(signal) {
  for (const child of children) child.kill(signal);
}
process.on('SIGINT', () => { stop('SIGINT'); process.exit(130); });
process.on('SIGTERM', () => { stop('SIGTERM'); process.exit(143); });
for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      stop('SIGTERM');
      process.exit(code);
    }
  });
}
