import http from 'node:http';

const request = http.get({ hostname: '127.0.0.1', port: process.env.PORT || 8080,
  path: '/healthz', timeout: 3000 }, response => {
  response.resume();
  response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1));
  response.on('error', () => process.exit(1));
});
request.on('timeout', () => request.destroy(new Error('Health check timed out')));
request.on('error', () => process.exit(1));
